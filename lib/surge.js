// Cross-item spike ("surge") detection — the aggregate crisis signal the
// per-item urgent alerts can't give you. A brand can slide into a crisis as ten
// separate importance-3 stories none of which trips the severity-5 urgent path;
// what's abnormal is the VOLUME, so we watch the volume.
//
// No new tables: the rolling baseline is computed live from pr_items +
// pr_instances each run over a trailing window (same rows the board/stats read,
// so it reconciles), and alert throttling reuses the existing pr_state
// timestamps. Fail-soft throughout — surge detection must never crash a run.
//
// WEIGHTED BY COVERAGE SPREAD, not raw count: a day's negative volume for a
// brand is the SUM of each negative story's outlet count (pr_instances), so one
// story running in six outlets outweighs three one-off mentions. A surge is
// today's weighted volume clearing mean + K·stddev of the trailing daily
// volumes AND a floor (so a quiet brand ticking 0→1 never cries wolf).

import { itemsForStats, instancesForItems, recentItems } from './db.js';

const BRANDS = ['Vodafone', 'Orange', 'WE', 'e&'];
const SERIES = [...BRANDS, 'Market'];
const brandOf = (it) => (BRANDS.includes(it.brand) ? it.brand : 'Market');

const cairoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayOf = (it) => {
  const t = it.published_at || it.seen_at;
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : cairoDay.format(d);
};

const numEnv = (v, dflt) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : dflt; };
const r1 = (x) => Math.round(x * 10) / 10;

// Detect brands whose TODAY (Cairo) weighted-negative volume breaks their
// trailing baseline. Returns an array of surge objects (empty if none). Pure
// read — no sends, no state writes; the caller throttles + delivers.
export async function detectSurges(opts = {}) {
  const windowDays = numEnv(process.env.SURGE_WINDOW_DAYS, opts.windowDays ?? 21);
  const K = numEnv(process.env.SURGE_K, opts.K ?? 2);
  const floor = numEnv(process.env.SURGE_MIN_VOLUME, opts.floor ?? 4);

  const items = await itemsForStats({ days: windowDays + 1 });
  const negatives = items.filter((i) => i.sentiment === 'negative');
  if (!negatives.length) return [];

  // Coverage-spread weight per negative item (fail-soft → count of 1 each).
  const weight = new Map();
  try {
    const ids = negatives.map((i) => i.id).filter(Boolean);
    const inst = {};
    for (let i = 0; i < ids.length; i += 150) Object.assign(inst, await instancesForItems(ids.slice(i, i + 150)));
    for (const n of negatives) weight.set(n.id, Math.max(1, (inst[n.id] || []).length));
  } catch (e) {
    console.error('surge: spread fetch failed, weighting by count=1', e.message);
    for (const n of negatives) weight.set(n.id, 1);
  }

  // Continuous Cairo-day axis (oldest → today); today is the last key.
  const days = [];
  const seen = new Set();
  for (let i = windowDays; i >= 0; i--) {
    const d = cairoDay.format(new Date(Date.now() - i * 864e5));
    if (!seen.has(d)) { seen.add(d); days.push(d); }
  }
  const today = days[days.length - 1];
  const baseDays = days.slice(0, -1);
  const inAxis = new Set(days);

  // Per-brand daily weighted volume (zero-filled so quiet days count in stddev).
  const vol = {};
  for (const b of SERIES) vol[b] = Object.fromEntries(days.map((d) => [d, 0]));
  for (const n of negatives) {
    const d = dayOf(n);
    if (!d || !inAxis.has(d)) continue;
    vol[brandOf(n)][d] += weight.get(n.id) || 1;
  }

  const surges = [];
  for (const b of SERIES) {
    const todayVol = vol[b][today] || 0;
    const base = baseDays.map((d) => vol[b][d] || 0);
    const mean = base.reduce((s, v) => s + v, 0) / (base.length || 1);
    const variance = base.reduce((s, v) => s + (v - mean) ** 2, 0) / (base.length || 1);
    const stddev = Math.sqrt(variance);
    const threshold = mean + K * stddev;
    // All three must hold: clears the statistical bar, clears the noise floor,
    // and is genuinely above the norm (guards the stddev≈0 quiet-brand case).
    if (todayVol >= floor && todayVol > mean && todayVol >= threshold) {
      surges.push({
        brand: b, today: r1(todayVol), mean: r1(mean), stddev: r1(stddev),
        threshold: r1(threshold), multiple: r1(todayVol / Math.max(mean, 1)),
        windowDays, topStories: [],
      });
    }
  }
  if (!surges.length) return [];

  // Attach the day's top contributing stories (by spread) for the alert body.
  const todayRows = await recentItems({ days: 1 }).catch(() => []);
  const byId = new Map((todayRows || []).map((r) => [r.id, r]));
  for (const s of surges) {
    s.topStories = negatives
      .filter((n) => dayOf(n) === today && brandOf(n) === s.brand)
      .sort((a, b) => (weight.get(b.id) || 1) - (weight.get(a.id) || 1))
      .slice(0, 3)
      .map((n) => {
        const row = byId.get(n.id) || n;
        return { id: n.id, headline: row.headline || '(story)', outlets: weight.get(n.id) || 1 };
      });
  }
  return surges;
}

/* ============================================================
   Render — one aggregate email for the whole surge (not per item)
   ============================================================ */

import { THEME as T, esc } from './email.js';

export function renderSurgeEmail(surges, boardUrl) {
  // No ?t= on board links: the board no longer reads it (auth is the sign-in
  // session, Bearer only) so it's pure leak surface. /api/go?id= stays — those
  // are unauthenticated share redirects.
  const origin = (boardUrl || process.env.BOARD_URL || 'https://pr-radar.example.com/').split('?')[0].replace(/\/+$/, '');
  const boardBase = `${origin}/`;
  const goLink = (id) => (id ? `${origin}/api/go?id=${id}` : boardBase);
  const timeCairo = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });

  const block = (s) => {
    const stories = s.topStories.map((st) =>
      `<div style="font-size:12.5px;line-height:1.5;color:${T.INK_SOFT};padding:2px 0;">
        <a href="${esc(goLink(st.id))}" style="color:${T.INK_SOFT};text-decoration:none;font-weight:600;">${esc(st.headline)}</a>
        <span style="color:${T.MUTED_2};"> · ${st.outlets} outlet${st.outlets === 1 ? '' : 's'}</span>
      </div>`).join('');
    const col = T.BRAND_COLOR[s.brand] || T.BRAND_COLOR.market;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;"><tr>
      <td width="4" bgcolor="${T.RED}" style="width:4px;background:${T.RED};font-size:0;line-height:0;">&nbsp;</td>
      <td bgcolor="${T.CARD}" style="background:${T.CARD};border:1px solid ${T.HAIRLINE_2};border-left:0;padding:13px 15px;font-family:${T.FONT};">
        <div style="font-size:15px;font-weight:bold;color:${T.INK};">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${col};vertical-align:middle;margin-right:7px;"></span>${esc(s.brand)}
          <span style="font-size:12px;font-weight:normal;color:${T.RED_DEEP};"> · ${s.multiple}× normal</span>
        </div>
        <div style="font-size:12px;color:${T.MUTED};padding:5px 0 8px;">
          ${s.today} weighted-negative today vs a ${s.windowDays}-day norm of ~${s.mean} (±${s.stddev}). Threshold ${s.threshold}.
        </div>
        ${stories}
      </td></tr></table>`;
  };

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="robots" content="noindex,nofollow">
<title>SURGE — PR Radar</title>
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%}
  table{border-collapse:collapse!important}
  a{color:${T.RED}}
  @media only screen and (max-width:620px){.container{width:100%!important}.px{padding-left:18px!important;padding-right:18px!important}}
</style>
</head>
<body style="margin:0;padding:0;background:#2a0606;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#2a0606;">
  Negative-coverage surge: ${esc(surges.map((s) => `${s.brand} ${s.multiple}×`).join(', '))}&nbsp;&zwnj;
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#2a0606;">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${T.PAPER};">

  <tr><td bgcolor="${T.RED}" style="background:${T.RED};padding:16px 22px 14px;border-top:5px solid ${T.OXBLOOD};" class="px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="font-family:${T.FONT};font-size:12px;font-weight:bold;color:#ffffff;letter-spacing:.5px;">PR&nbsp;RADAR</td>
      <td align="right" valign="middle">
        <span style="display:inline-block;background:${T.OXBLOOD};color:#ffffff;font-size:13px;font-weight:bold;letter-spacing:2px;padding:7px 14px;border-radius:6px;">▲ SURGE</span>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>
      <td style="border-top:3px solid #ffffff;padding-top:11px;font-family:${T.FONT};font-size:11px;line-height:1.5;color:#ffc9c9;">
        Negative coverage broke the baseline for <strong style="color:#ffffff;">${surges.length} brand${surges.length === 1 ? '' : 's'}</strong> · ${timeCairo} Cairo. Weighted by how many outlets ran each story, not raw count.
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:14px 22px 4px;" class="px">
    ${surges.map(block).join('')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 8px;"><tr>
      <td align="center" bgcolor="${T.RED}" style="background:${T.RED};border-radius:9px;">
        <a href="${esc(boardBase)}" style="display:block;padding:13px 24px;font-family:${T.FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Open the board →</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td bgcolor="${T.PAPER_2}" style="background:${T.PAPER_2};padding:16px 22px 22px;font-family:${T.FONT};" class="px">
    <div style="font-size:11px;line-height:1.6;color:${T.MUTED_2};">
      Surge alerts fire once per brand per throttle window when weighted negative volume clears its rolling baseline — an aggregate signal, distinct from the per-story urgent alerts. Built for the PR &amp; Communications team · Vodafone Egypt.
    </div>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}
