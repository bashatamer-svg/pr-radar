// Weekly / monthly PR report — a period digest with period-over-period movement.
//
// Distinct from the DAILY bulletin (lib/email.js): the bulletin answers "what
// landed today"; this answers "how did the last week/month move vs the one
// before it" — share-of-voice shift, category movement, the period's worst
// negatives, and the wins. It reuses the bulletin's design tokens and card
// renderer (THEME + itemCardHtml from email.js) so the two surfaces read as one
// system, and the SAME window predicate as the board/stats (via itemsForStats /
// recentItems) so the numbers reconcile.
//
// Rendered HTML is email-client-safe (table layout, inline styles) so the exact
// same output prints from a browser AND sends through Resend unchanged.

import { itemsForStats, recentItems, instancesForItems, itemsBetween } from './db.js';
import { THEME, itemCardHtml, esc } from './email.js';

const BRANDS = ['Vodafone', 'Orange', 'WE', 'e&'];
const SERIES = [...BRANDS, 'Market'];
const brandOf = (it) => (BRANDS.includes(it.brand) ? it.brand : 'Market');
const sentOf = (it) => (it.sentiment === 'negative' || it.sentiment === 'positive' ? it.sentiment : 'neutral');
const tsOf = (it) => new Date(it.published_at || it.seen_at || 0).getTime();

// Build the report dataset: this period (last `days`) compared against the
// immediately preceding period of the same length. One 2×window fetch, split
// by timestamp — so current-half counts reconcile exactly with the board/stats
// for the same window.
export async function buildReport({ days = 7 } = {}) {
  const now = Date.now();
  const curFrom = now - days * 864e5;
  const prevFrom = now - 2 * days * 864e5;

  const all = await itemsForStats({ days: 2 * days });
  const cur = [], prev = [];
  for (const it of all) {
    const t = tsOf(it);
    if (t >= curFrom) cur.push(it);
    else if (t >= prevFrom) prev.push(it);
  }

  // Per-brand mentions + negatives, both periods.
  const blank = () => Object.fromEntries(SERIES.map((b) => [b, { mentions: 0, neg: 0 }]));
  const curB = blank(), prevB = blank();
  for (const it of cur) { const b = brandOf(it); curB[b].mentions++; if (sentOf(it) === 'negative') curB[b].neg++; }
  for (const it of prev) { const b = brandOf(it); prevB[b].mentions++; if (sentOf(it) === 'negative') prevB[b].neg++; }

  const curTot = cur.length || 1, prevTot = prev.length || 1;
  const sov = SERIES.map((b) => ({
    brand: b,
    cur: curB[b].mentions,
    prev: prevB[b].mentions,
    neg: curB[b].neg,
    sharePct: Math.round((curB[b].mentions / curTot) * 100),
    prevSharePct: Math.round((prevB[b].mentions / prevTot) * 100),
  }));

  // Category movement.
  const catCur = new Map(), catPrev = new Map();
  for (const it of cur) { const c = it.category || 'other'; catCur.set(c, (catCur.get(c) || 0) + 1); }
  for (const it of prev) { const c = it.category || 'other'; catPrev.set(c, (catPrev.get(c) || 0) + 1); }
  const categories = [...new Set([...catCur.keys(), ...catPrev.keys()])]
    .filter((c) => c !== 'unclassified')
    .map((c) => ({ category: c, cur: catCur.get(c) || 0, prev: catPrev.get(c) || 0 }))
    .sort((a, b) => b.cur - a.cur || b.prev - a.prev);

  const totals = {
    items: cur.length, prevItems: prev.length,
    negatives: cur.filter((i) => sentOf(i) === 'negative').length,
    prevNegatives: prev.filter((i) => sentOf(i) === 'negative').length,
    positives: cur.filter((i) => sentOf(i) === 'positive').length,
    prevPositives: prev.filter((i) => sentOf(i) === 'positive').length,
    vodShare: sov.find((s) => s.brand === 'Vodafone').sharePct,
    vodSharePrev: sov.find((s) => s.brand === 'Vodafone').prevSharePct,
  };

  // Rich rows for the highlight cards. recentItems() returns full pr_items rows
  // for the current window, ordered by importance — so the top negatives/wins
  // are within reach even on a busy month. Reused so cards render identically
  // to the daily bulletin.
  // The two spotlight lists are action-framed ("needs attention" / "to amplify"),
  // so they are Vodafone-only — a competitor's negative isn't ours to answer and
  // its positive isn't ours to boost. Competitors still count in the SoV, category
  // and sentiment analytics below; they're just not surfaced as our action items.
  const rich = (await recentItems({ days }).catch(() => [])) || [];
  const topNeg = rich.filter((i) => sentOf(i) === 'negative' && i.brand === 'Vodafone')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 6);
  const wins = rich.filter((i) => sentOf(i) === 'positive' && i.brand === 'Vodafone')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 4);

  // Attach coverage instances for the card renderer's "Coverage · N outlets".
  try {
    const ids = [...topNeg, ...wins].map((i) => i.id).filter(Boolean);
    const map = await instancesForItems(ids);
    for (const it of [...topNeg, ...wins]) it._instances = map[it.id] || [];
  } catch (e) {
    console.error('report instances fetch failed (non-fatal)', e.message);
  }

  return { days, generatedAt: new Date(now).toISOString(), totals, sov, categories, topNeg, wins };
}

/* ============================================================
   Custom date-range report (the /reports builder)
   ============================================================ */

// Exact ms of 00:00 Cairo on a YYYY-MM-DD date (DST-correct via Intl).
function cairoDayStartMs(dateStr) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(part?.value || 'GMT+2');
  const offMin = (Number(m?.[1] || 2) * 60) + (Number(m?.[2] || 0) * Math.sign(Number(m?.[1] || 2)));
  return guess - offMin * 60e3;
}

/** Parse + validate a from/to pair of Cairo dates (inclusive). Throws with a
    caller-safe message on bad input. */
export function parseCairoRange(fromStr, toStr) {
  const RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!RE.test(String(fromStr)) || !RE.test(String(toStr))) throw new Error('from/to must be YYYY-MM-DD dates');
  const fromMs = cairoDayStartMs(fromStr);
  const toMs = cairoDayStartMs(toStr) + 864e5;   // inclusive end day
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('invalid date');
  if (toMs <= fromMs) throw new Error('the "to" date is before the "from" date');
  const days = Math.round((toMs - fromMs) / 864e5);
  if (days > 92) throw new Error('range is limited to 92 days');
  return { fromMs, toMs, days, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}

/** Report dataset for an EXPLICIT window, compared against the immediately
    preceding window of equal length. Also carries the full coverage-log
    appendix (every relevant story in the window, capped 400). Kept separate
    from buildReport() so the weekly-email path stays byte-identical. */
export async function buildReportRange({ fromMs, toMs }) {
  const days = Math.round((toMs - fromMs) / 864e5);
  const fromIso = new Date(fromMs).toISOString(), toIso = new Date(toMs).toISOString();
  const prevFromIso = new Date(fromMs - (toMs - fromMs)).toISOString();

  const [curFull, prevLean] = await Promise.all([
    itemsBetween({ fromIso, toIso, cols: 'full' }),
    itemsBetween({ fromIso: prevFromIso, toIso: fromIso, cols: 'lean' }),
  ]);
  const cur = curFull, prev = prevLean;

  const blank = () => Object.fromEntries(SERIES.map((b) => [b, { mentions: 0, neg: 0 }]));
  const curB = blank(), prevB = blank();
  for (const it of cur) { const b = brandOf(it); curB[b].mentions++; if (sentOf(it) === 'negative') curB[b].neg++; }
  for (const it of prev) { const b = brandOf(it); prevB[b].mentions++; if (sentOf(it) === 'negative') prevB[b].neg++; }
  const curTot = cur.length || 1, prevTot = prev.length || 1;
  const sov = SERIES.map((b) => ({
    brand: b, cur: curB[b].mentions, prev: prevB[b].mentions, neg: curB[b].neg,
    sharePct: Math.round((curB[b].mentions / curTot) * 100),
    prevSharePct: Math.round((prevB[b].mentions / prevTot) * 100),
  }));

  const catCur = new Map(), catPrev = new Map();
  for (const it of cur) { const c = it.category || 'other'; catCur.set(c, (catCur.get(c) || 0) + 1); }
  for (const it of prev) { const c = it.category || 'other'; catPrev.set(c, (catPrev.get(c) || 0) + 1); }
  const categories = [...new Set([...catCur.keys(), ...catPrev.keys()])]
    .filter((c) => c !== 'unclassified')
    .map((c) => ({ category: c, cur: catCur.get(c) || 0, prev: catPrev.get(c) || 0 }))
    .sort((a, b) => b.cur - a.cur || b.prev - a.prev);

  const totals = {
    items: cur.length, prevItems: prev.length,
    negatives: cur.filter((i) => sentOf(i) === 'negative').length,
    prevNegatives: prev.filter((i) => sentOf(i) === 'negative').length,
    positives: cur.filter((i) => sentOf(i) === 'positive').length,
    prevPositives: prev.filter((i) => sentOf(i) === 'positive').length,
    vodShare: sov.find((s) => s.brand === 'Vodafone').sharePct,
    vodSharePrev: sov.find((s) => s.brand === 'Vodafone').prevSharePct,
    distinctOutlets: new Set(cur.map((i) => i.source).filter(Boolean)).size,
  };

  const topNeg = cur.filter((i) => sentOf(i) === 'negative' && i.brand === 'Vodafone')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 6);
  const wins = cur.filter((i) => sentOf(i) === 'positive' && i.brand === 'Vodafone')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 4);
  try {
    const ids = [...topNeg, ...wins].map((i) => i.id).filter(Boolean);
    const map = await instancesForItems(ids);
    for (const it of [...topNeg, ...wins]) it._instances = map[it.id] || [];
  } catch (e) { console.error('range-report instances fetch failed (non-fatal)', e.message); }

  // Coverage log — the raw extract. Cap to the newest 400 FIRST (so a too-wide
  // range drops the oldest stories, never a whole operator), then group by
  // operator — Vodafone, Orange, WE, e& — with everything else under Market,
  // newest first within each group.
  const gIdx = (i) => { const g = BRANDS.indexOf(i.brand); return g === -1 ? BRANDS.length : g; };
  const appendix = cur.slice()
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, 400)
    .sort((a, b) => gIdx(a) - gIdx(b) || tsOf(b) - tsOf(a))
    .map((i) => ({
      date: i.published_at || i.seen_at, headline: i.headline, url: i.resolved_url || i.url || '',
      outlet: i.source || '—', author: i.author || null, brand: i.brand || 'market',
      group: BRANDS.includes(i.brand) ? i.brand : 'Market',
      sentiment: sentOf(i), importance: i.importance || 1, category: i.category || 'other',
    }));
  const appendixTruncated = cur.length > 400 ? cur.length - 400 : 0;

  return { days, fromMs, toMs, generatedAt: new Date().toISOString(), totals, sov, categories, topNeg, wins, appendix, appendixTruncated };
}

/* ============================================================
   Render — email-safe + printable
   ============================================================ */

const T = THEME;

// A signed delta, coloured by whether the direction is good. `badUp` flips it
// for metrics where an increase is bad (negatives).
function deltaHtml(cur, prev, { badUp = false, neutral = false } = {}) {
  const d = cur - prev;
  if (d === 0) return `<span style="color:${T.MUTED_2};font-weight:600;">±0</span>`;
  const up = d > 0;
  const arrow = up ? '▲' : '▼';
  const color = neutral ? T.MUTED : ((badUp ? !up : up) ? '#137a45' : T.RED_DEEP);
  return `<span style="color:${color};font-weight:700;white-space:nowrap;">${arrow}&nbsp;${Math.abs(d)}</span>`;
}

function rangeLabel(generatedAt, days) {
  const end = new Date(generatedAt);
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const fmt = (dt, withYear) => dt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'Africa/Cairo',
  });
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

function kpiTile(label, value, deltaCell) {
  return `<td width="25%" valign="top" style="padding:0 5px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.CARD};border:1px solid ${T.HAIRLINE_2};border-radius:10px;">
      <tr><td style="padding:12px 13px;font-family:${T.FONT};">
        <div style="font-size:10.5px;font-weight:bold;color:${T.MUTED};letter-spacing:.02em;">${esc(label)}</div>
        <div style="font-size:25px;font-weight:bold;color:${T.INK};letter-spacing:-.02em;padding-top:5px;line-height:1.05;">${esc(String(value))}</div>
        <div style="font-size:10.5px;padding-top:4px;">${deltaCell}</div>
      </td></tr>
    </table></td>`;
}

function sovRow(s) {
  const share = `${s.sharePct}%`;
  const barW = Math.max(2, s.sharePct);
  const col = T.BRAND_COLOR[s.brand] || T.BRAND_COLOR[s.brand === 'Market' ? 'market' : s.brand] || T.MUTED_2;
  return `<tr>
    <td style="padding:7px 8px 7px 0;font-family:${T.FONT};font-size:12.5px;font-weight:bold;color:${T.INK_SOFT};white-space:nowrap;">
      <span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${col};vertical-align:middle;margin-right:6px;"></span>${esc(s.brand)}
    </td>
    <td width="42%" style="padding:7px 8px;">
      <div style="background:${T.PAPER_2};border-radius:4px;height:9px;"><div style="width:${barW}%;height:9px;border-radius:4px;background:${col};"></div></div>
    </td>
    <td align="right" style="padding:7px 0 7px 8px;font-family:${T.FONT};font-size:12px;color:${T.INK_SOFT};white-space:nowrap;">
      <b>${s.cur}</b> <span style="color:${T.MUTED_2};">· ${share}</span>
    </td>
    <td align="right" style="padding:7px 0 7px 10px;font-family:${T.FONT};font-size:12px;white-space:nowrap;">
      ${deltaHtml(s.cur, s.prev, { badUp: s.brand === 'Vodafone', neutral: s.brand !== 'Vodafone' })}
    </td>
  </tr>`;
}

function catRow(c) {
  const name = String(c.category).replace(/_/g, ' ');
  return `<tr>
    <td style="padding:6px 8px 6px 0;font-family:${T.FONT};font-size:12.5px;color:${T.INK_SOFT};text-transform:capitalize;">${esc(name)}</td>
    <td align="right" style="padding:6px 0;font-family:${T.FONT};font-size:12.5px;color:${T.INK};font-weight:bold;">${c.cur}</td>
    <td align="right" style="padding:6px 0 6px 12px;font-family:${T.FONT};font-size:12px;white-space:nowrap;">${deltaHtml(c.cur, c.prev, { neutral: true })}</td>
  </tr>`;
}

function sectionHead(label, color, sub) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:22px 0 8px;font-family:${T.FONT};font-size:14px;font-weight:bold;color:${color};">
      ${esc(label)}${sub ? `<span style="font-weight:normal;font-size:11px;color:${T.FAINT};">&nbsp;·&nbsp;${esc(sub)}</span>` : ''}
    </td></tr>
    <tr><td style="border-top:1px solid ${T.HAIRLINE};font-size:0;line-height:0;">&nbsp;</td></tr>
  </table>`;
}

export function renderReport(data, { period = 'week', title = null, rangeText = null, appendix = false } = {}) {
  const { totals, sov, categories, topNeg, wins, days, generatedAt } = data;
  // No ?t= on board links — the board ignores it now (Bearer-session auth); it
  // was only a leak surface in emails.
  const origin = (process.env.BOARD_URL || 'https://pr-radar.example.com/').split('?')[0].replace(/\/+$/, '');
  const boardBase = `${origin}/`;
  const periodTitle = title || (period === 'month' ? 'Monthly report' : 'Weekly report');
  const range = rangeText || rangeLabel(generatedAt, days);

  // Executive summary — the 30-second read a director actually gets to. Plain,
  // factual sentences composed from the numbers; no adjectives the data can't back.
  const dItems = totals.items - totals.prevItems;
  const negPct = totals.items ? Math.round((totals.negatives / totals.items) * 100) : 0;
  const sovDelta = totals.vodShare - totals.vodSharePrev;
  const execSentences = [
    `The period logged <b>${totals.items}</b> brand-relevant stor${totals.items === 1 ? 'y' : 'ies'} (${dItems === 0 ? 'level with' : `${dItems > 0 ? '+' : ''}${dItems} vs`} the prior period).`,
    `<b>${totals.negatives}</b> ran negative (${negPct}% of coverage) and <b>${totals.positives}</b> positive.`,
    `Vodafone held <b>${totals.vodShare}%</b> share of voice${sovDelta === 0 ? ', level with' : ` (${sovDelta > 0 ? '+' : ''}${sovDelta} pts vs)`} the prior period.`,
    topNeg.length
      ? `<b>${topNeg.length}</b> Vodafone stor${topNeg.length === 1 ? 'y' : 'ies'} met the needs-response bar — the highest-reach: “${esc(String(topNeg[0].headline || '').slice(0, 110))}”.`
      : 'No Vodafone negatives met the response bar — a clean period.',
  ];
  const execHtml = `${sectionHead('Executive summary', T.INK)}
    <div dir="auto" style="font-family:${T.FONT};font-size:13.5px;line-height:1.75;color:${T.INK_SOFT};padding:4px 0 2px;">${execSentences.join(' ')}</div>`;

  // Coverage log appendix + methodology — only on the exported report
  // (appendix:true); the emailed weekly stays lean.
  let appendixHtml = '';
  if (appendix && Array.isArray(data.appendix)) {
    const SENT_COL = { negative: T.RED_DEEP, positive: '#137a45', neutral: T.MUTED };
    // Group header rows: one per operator (then Market), with its story count.
    const groupOf = (r) => r.group || r.brand || 'Market';
    const counts = {};
    for (const r of data.appendix) counts[groupOf(r)] = (counts[groupOf(r)] || 0) + 1;
    let lastGroup = null;
    const rows = data.appendix.map((r) => {
      const g = groupOf(r);
      const header = g === lastGroup ? '' : `<tr><td colspan="5" style="padding:14px 0 4px;border-bottom:2px solid ${g === 'Vodafone' ? T.RED : T.HAIRLINE};font-family:${T.FONT};font-size:12px;font-weight:bold;color:${g === 'Vodafone' ? T.RED : T.INK};">
        ${esc(g === 'Market' ? 'Market & sector' : g)}&nbsp;<span style="font-weight:normal;font-size:10.5px;color:${T.MUTED_2};">· ${counts[g]} stor${counts[g] === 1 ? 'y' : 'ies'}</span></td></tr>`;
      lastGroup = g;
      const d = r.date ? new Date(r.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Africa/Cairo' }) : '—';
      const head = r.url ? `<a href="${esc(r.url)}" style="color:${T.INK};text-decoration:none;">${esc(r.headline)}</a>` : esc(r.headline);
      return header + `<tr>
        <td valign="top" style="padding:5px 8px 5px 0;font-family:${T.FONT};font-size:10.5px;color:${T.MUTED};white-space:nowrap;">${d}</td>
        <td valign="top" dir="auto" style="padding:5px 8px 5px 0;font-family:${T.FONT};font-size:11px;line-height:1.45;color:${T.INK};">${head}
          <div style="font-size:10px;color:${T.MUTED_2};">${esc(r.outlet)}${r.author ? ` · ${esc(r.author)}` : ' · newsroom'}</div></td>
        <td valign="top" style="padding:5px 8px 5px 0;font-family:${T.FONT};font-size:10.5px;color:${T.INK_SOFT};white-space:nowrap;">${esc(r.brand)}</td>
        <td valign="top" style="padding:5px 8px 5px 0;font-family:${T.FONT};font-size:10.5px;font-weight:bold;color:${SENT_COL[r.sentiment] || T.MUTED};">${esc(r.sentiment)}</td>
        <td valign="top" align="right" style="padding:5px 0;font-family:${T.FONT};font-size:10.5px;color:${T.INK_SOFT};">${r.importance}/5</td>
      </tr>`;
    }).join('');
    const truncNote = data.appendixTruncated
      ? `<div style="font-family:${T.FONT};font-size:10.5px;color:${T.MUTED_2};padding-top:6px;">+${data.appendixTruncated} more stories beyond the 400-row cap — narrow the range for the full log.</div>` : '';
    appendixHtml = `
      ${sectionHead('Appendix — coverage log', T.OXBLOOD, `${data.appendix.length} stor${data.appendix.length === 1 ? 'y' : 'ies'} · by operator, then market · newest first`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:2px;">
        <tr><td style="font-family:${T.FONT};font-size:9.5px;color:${T.FAINT};">date</td>
            <td style="font-family:${T.FONT};font-size:9.5px;color:${T.FAINT};">headline · outlet · author</td>
            <td style="font-family:${T.FONT};font-size:9.5px;color:${T.FAINT};">brand</td>
            <td style="font-family:${T.FONT};font-size:9.5px;color:${T.FAINT};">tone</td>
            <td align="right" style="font-family:${T.FONT};font-size:9.5px;color:${T.FAINT};">reach</td></tr>
        ${rows}
      </table>${truncNote}
      ${sectionHead('Methodology', T.MUTED)}
      <div style="font-family:${T.FONT};font-size:10.5px;line-height:1.6;color:${T.MUTED};">
        Coverage window ${esc(range)} (Cairo days, inclusive), compared against the immediately preceding period of equal length.
        Sources: brand &amp; market Google&nbsp;News sweeps plus direct Egyptian outlet feeds. Stories are AI-classified
        (brand, tone, reach 1–5) and de-duplicated across outlets; the coverage log groups them by operator —
        Vodafone, Orange, WE, e&amp; — then the wider market &amp; sector, newest first within each group.
        Unbylined articles are attributed to the publication's newsroom.
        Tone and reach are model judgements — low-confidence items are flagged on the live board. Generated ${esc(new Date(generatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))} Cairo · PR Radar.
      </div>`;
  }
  const timeCairo = new Date(generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });

  const vodShareDelta = totals.vodShare - totals.vodSharePrev;
  const vodDeltaTxt = vodShareDelta === 0
    ? `<span style="color:${T.MUTED_2};">±0 pts vs prior</span>`
    : `<span style="color:${(vodShareDelta > 0 ? T.RED_DEEP : '#137a45')};font-weight:700;">${vodShareDelta > 0 ? '▲' : '▼'} ${Math.abs(vodShareDelta)} pts</span> <span style="color:${T.MUTED_2};">vs prior</span>`;

  const kpis = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px -5px 0;"><tr>
    ${kpiTile('Items tracked', totals.items, `${deltaHtml(totals.items, totals.prevItems, { neutral: true })} <span style="color:${T.MUTED_2};">vs prior ${totals.prevItems}</span>`)}
    ${kpiTile('Negative', totals.negatives, `${deltaHtml(totals.negatives, totals.prevNegatives, { badUp: true })} <span style="color:${T.MUTED_2};">vs ${totals.prevNegatives}</span>`)}
    ${kpiTile('Vodafone SoV', `${totals.vodShare}%`, vodDeltaTxt)}
    ${kpiTile('Positive', totals.positives, `${deltaHtml(totals.positives, totals.prevPositives)} <span style="color:${T.MUTED_2};">vs ${totals.prevPositives}</span>`)}
  </tr></table>`;

  const sovTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;">
    <tr><td colspan="4" style="font-family:${T.FONT};font-size:10px;color:${T.FAINT};padding-bottom:2px;">brand · mentions · share · change vs prior period</td></tr>
    ${sov.filter((s) => s.cur > 0 || s.prev > 0).map(sovRow).join('')}
  </table>`;

  const catList = categories.slice(0, 8);
  const catTable = catList.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;">
        <tr><td style="font-family:${T.FONT};font-size:10px;color:${T.FAINT};">category</td>
            <td align="right" style="font-family:${T.FONT};font-size:10px;color:${T.FAINT};">items</td>
            <td align="right" style="font-family:${T.FONT};font-size:10px;color:${T.FAINT};padding-left:12px;">Δ</td></tr>
        ${catList.map(catRow).join('')}
      </table>`
    : `<div style="font-family:${T.FONT};font-size:13px;color:${T.MUTED};padding:10px 0;">No categorised coverage in this period.</div>`;

  const negCards = topNeg.length
    ? topNeg.map((it) => itemCardHtml(it, boardBase)).join('')
    : `<div style="font-family:${T.FONT};font-size:13px;color:${T.MUTED};padding:12px 0;">No negative coverage this period — a clean run.</div>`;
  const winCards = wins.length
    ? wins.map((it) => itemCardHtml(it, boardBase)).join('')
    : `<div style="font-family:${T.FONT};font-size:13px;color:${T.MUTED};padding:12px 0;">No clear brand wins captured this period.</div>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="robots" content="noindex,nofollow">
<title>PR Radar — ${esc(periodTitle)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-collapse:collapse!important}
  img{border:0;line-height:100%;outline:none;text-decoration:none}
  a{color:${T.RED}}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:16px!important;padding-right:16px!important}
  }
  @media print{ body{background:#fff!important} .noprint{display:none!important} .container{width:100%!important} }
</style>
</head>
<body style="margin:0;padding:0;background:${T.CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.CANVAS};">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${T.PAPER};">

  <tr><td bgcolor="${T.RED}" style="background:${T.RED};padding:20px 22px 16px;" class="px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td width="44" style="width:44px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="42" height="42" align="center" valign="middle" bgcolor="#ffffff" style="width:42px;height:42px;border-radius:11px;font-family:${T.FONT};font-size:14px;font-weight:bold;color:${T.RED};">PR</td>
        </tr></table>
      </td>
      <td style="padding-left:13px;font-family:${T.FONT};">
        <div style="font-size:21px;font-weight:bold;color:#ffffff;line-height:1.1;letter-spacing:-.3px;">${esc(periodTitle)}</div>
        <div style="font-size:10px;color:#ffd0d0;letter-spacing:1.2px;padding-top:4px;">BRAND &amp; REPUTATION &nbsp;·&nbsp; ${esc(range)} &nbsp;·&nbsp; VODAFONE EGYPT</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:16px 22px 4px;" class="px">
    ${kpis}
  </td></tr>

  <tr><td style="padding:0 22px;" class="px">
    ${execHtml}
    ${sectionHead('Share of voice — shift vs prior', T.OXBLOOD, `${days}-day window`)}
    ${sovTable}
    ${sectionHead('Category movement', T.OXBLOOD)}
    ${catTable}
    ${sectionHead('Top negatives — needs attention', T.RED, `${topNeg.length} shown`)}
    ${negCards}
    ${sectionHead('Wins to amplify', '#137a45', `${wins.length} shown`)}
    ${winCards}
    ${appendixHtml}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 6px;" class="noprint"><tr>
      <td align="center" bgcolor="${T.RED}" style="background:${T.RED};border-radius:9px;">
        <a href="${esc(boardBase)}" style="display:block;padding:13px 24px;font-family:${T.FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Open the live board →</a>
      </td>${appendix ? `
      <td width="10" style="width:10px;font-size:0;">&nbsp;</td>
      <td align="center" style="border:1.5px solid ${T.RED};border-radius:9px;">
        <a href="#" onclick="window.print();return false;" style="display:block;padding:12px 20px;font-family:${T.FONT};font-size:14px;font-weight:bold;color:${T.RED};text-decoration:none;">🖨 Print / save as PDF</a>
      </td>` : ''}
    </tr></table>
  </td></tr>

  <tr><td bgcolor="${T.PAPER_2}" style="background:${T.PAPER_2};padding:18px 22px 24px;font-family:${T.FONT};" class="px">
    <div style="font-size:11px;line-height:1.6;color:${T.MUTED_2};">
      ${esc(periodTitle)} for the PR &amp; Communications team · Vodafone Egypt.<br>
      Generated ${esc(timeCairo)} Cairo · this period vs the preceding ${days} days.
    </div>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}
