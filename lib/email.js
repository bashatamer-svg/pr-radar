// Email templates — daily PR brief + URGENT single-item reputational alert.
// Table-based inline-styled HTML for Gmail / Outlook compatibility.
// Design system: Vodafone Egypt · PR & Communications (brand-adjacent).

const esc = (s) =>
  String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Palette (Vodafone-adjacent).
const RED = '#e60000';
const RED_DEEP = '#b30000';
const OXBLOOD = '#4a0a0a';
const INK = '#1a1214';
const INK_SOFT = '#3a2b28';
const MUTED = '#6d605d';
const MUTED_2 = '#9a8d8a';
const FAINT = '#a89b98';
const PAPER = '#faf8f7';
const PAPER_2 = '#f0eae8';
const CANVAS = '#e7e2e0';
const CARD = '#ffffff';
const HAIRLINE = '#e3d6d3';
const HAIRLINE_2 = '#ead0cc';
const CHIP_BG = '#f0e6e4';

const FONT = 'Arial,Helvetica,sans-serif';

// Sentiment system — the heart of a PR read. Negative is loud (red, tinted
// card); positive is green; neutral is a calm slate. Kept in sync with the
// board so email and board read as one design.
const SENT = {
  negative: { label: 'Negative', color: RED_DEEP, spine: RED,     bg: '#fdf2f0', pill: `color:#ffffff;background:${RED}` },
  positive: { label: 'Positive', color: '#137a45', spine: '#1a9455', bg: '#eef8f1', pill: 'color:#ffffff;background:#1a9455' },
  neutral:  { label: 'Neutral',  color: '#4f5a67', spine: '#9aa4b0', bg: '#f3f5f7', pill: 'color:#ffffff;background:#7a8694' },
};
const sentOf = (it) => SENT[it && it.sentiment] || SENT.neutral;

// Brand chip colours — the four tracked brands + a market catch-all.
const BRAND_COLOR = {
  Vodafone: RED, Orange: '#ff7900', WE: '#6a1b9a', 'e&': '#00857b', market: '#6d605d',
};

// Severity ramp (importance 1..5) — reputational reach/impact, distinct hues.
const IMP = { 5: RED, 4: '#f27100', 3: '#e2a900', 2: '#3a7ac2', 1: '#8a807d' };
const IMP_EMPTY = '#d9cdca';

const IMP_LABELS = [
  { imp: 5, label: 'Crisis' },
  { imp: 4, label: 'High' },
  { imp: 3, label: 'Watch' },
  { imp: 2, label: 'Low' },
  { imp: 1, label: 'Info' },
];
function legendStripHtml() {
  const items = IMP_LABELS.map(({ imp, label }) =>
    `<td style="padding:2px 8px 2px 0;font-family:${FONT};font-size:11px;color:${INK_SOFT};white-space:nowrap;">
       <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${IMP[imp]};vertical-align:middle;margin-right:5px;"></span>${label}
     </td>`
  ).join('');
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 4px;background:${PAPER_2};border-radius:8px;">
    <tr><td style="padding:8px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:2px 10px 2px 0;font-family:${FONT};font-size:9px;font-weight:bold;color:${OXBLOOD};letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;">Severity</td>
        ${items}
      </tr></table>
    </td></tr>
  </table>`;
}

// Board / share origin from BOARD_URL (falls back to a placeholder domain).
const RAW_BOARD_URL = process.env.BOARD_URL || 'https://pr-radar.example.com/';
const ORIGIN = RAW_BOARD_URL.split('?')[0].replace(/\/+$/, '');
const BOARD_LINK = RAW_BOARD_URL;

/* ============================================================
   Shared helpers
   ============================================================ */

function severityDots(imp) {
  const n = Math.max(1, Math.min(5, imp || 1));
  const col = IMP[n] || IMP[2];
  const filled = '&#9679;'.repeat(n);
  const empty = `<span style="color:${IMP_EMPTY}">${'&#9679;'.repeat(5 - n)}</span>`;
  return `<span style="color:${col};letter-spacing:2px;white-space:nowrap;">${filled}${empty}</span>`;
}

function ageLabel(item) {
  const t = item.published_at || item.seen_at;
  if (!t) return '';
  const h = Math.max(0, (Date.now() - new Date(t).getTime()) / 36e5);
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Render the classifier's labelled pr_angle (Read / Audience / Action) into a
// small label|value table. Falls back to a plain paragraph if it carries no
// recognisable labels. Generic over the label names, so it never silently drops
// a line the way a hard-coded Impact/Timing parser would.
function renderAngleEmail(text, valColor, valFontSize = 13) {
  const src = String(text || '').trim();
  if (!src) return '';
  const lines = [];
  for (const raw of src.split(/\r?\n+/)) {
    const m = raw.trim().match(/^([A-Za-z][A-Za-z /&]*?)\s*[·:\-–—]\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (!val || /^[—–\-·.\s]*$/.test(val)) continue;
    lines.push({ label: m[1].trim(), val });
  }
  if (!lines.length) {
    return `<div style="font-size:${valFontSize}px;line-height:1.45;color:${valColor};padding-top:3px;">${esc(src)}</div>`;
  }
  const row = (label, val) => `<tr>
      <td valign="top" style="width:76px;padding:4px 10px 4px 0;font-size:9.5px;font-weight:700;letter-spacing:.12em;color:${RED};text-transform:uppercase;white-space:nowrap;">${esc(label)}</td>
      <td valign="top" style="padding:4px 0;font-size:${valFontSize}px;line-height:1.45;color:${valColor};">${esc(val)}</td>
    </tr>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:4px;">${lines.map((l) => row(l.label, l.val)).join('')}</table>`;
}

// The coverage list — every outlet that ran the story, with its byline. This is
// the PR payload: who published it, and everywhere it appeared. Only shown when
// there's more than one instance (the header already names the primary outlet).
function coverageHtml(insts) {
  const list = Array.isArray(insts) ? insts.filter((x) => x && (x.outlet || x.url)) : [];
  if (list.length < 2) return '';
  const rows = list.slice(0, 12).map((x) => {
    const name = esc(x.outlet || '—');
    const linked = x.url ? `<a href="${esc(x.url)}" style="color:${INK_SOFT};text-decoration:none;font-weight:600;">${name}</a>` : `<span style="font-weight:600;">${name}</span>`;
    const by = x.author ? ` <span style="color:${MUTED_2};">· ${esc(x.author)}</span>` : '';
    return `<div style="font-size:11.5px;line-height:1.5;color:${INK_SOFT};padding:1px 0;">${linked}${by}</div>`;
  }).join('');
  const more = list.length > 12 ? `<div style="font-size:11px;color:${MUTED_2};padding-top:2px;">+${list.length - 12} more outlet${list.length - 12 === 1 ? '' : 's'}</div>` : '';
  return `
  <div style="margin-top:11px;padding:9px 12px;background:${PAPER_2};border-radius:7px;">
    <div style="font-size:9px;font-weight:bold;letter-spacing:1.4px;color:${OXBLOOD};text-transform:uppercase;padding-bottom:5px;">Coverage · ${list.length} outlet${list.length === 1 ? '' : 's'}</div>
    ${rows}${more}
  </div>`;
}

function itemCardHtml(it, boardBase) {
  const s = sentOf(it);
  const dots = severityDots(it.importance);
  const age = ageLabel(it);
  const outletAge = it.source ? `${esc(it.source)}${age ? ' · ' + esc(age) : ''}` : esc(age);
  const brandChip = it.brand
    ? `<span style="background:${BRAND_COLOR[it.brand] || MUTED};color:#ffffff;font-weight:bold;padding:2px 7px;border-radius:4px;font-size:10px;letter-spacing:.3px;">${esc(it.brand)}</span>`
    : '';
  const catChip = it.category
    ? `<span style="background:${CHIP_BG};color:${OXBLOOD};padding:2px 6px;border-radius:4px;font-size:10px;">${esc(String(it.category).replace(/_/g, ' '))}</span>`
    : '';
  const sentBadge = `<span style="display:inline-block;font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:4px;${s.pill};">${s.label}</span>`;
  const byline = `<span style="color:${it.author ? INK_SOFT : MUTED_2};">${it.author ? 'By ' + esc(it.author) : 'Author —'}</span>`;
  const boardItem = it.id ? `${boardBase}#item-${it.id}` : boardBase;
  const headlineHref = it.id ? `${ORIGIN}/api/go?id=${it.id}` : (it.url || BOARD_LINK);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;"><tr>
    <td width="4" bgcolor="${s.spine}" style="width:4px;background:${s.spine};font-size:0;line-height:0;">&nbsp;</td>
    <td bgcolor="${CARD}" style="background:${CARD};border:1px solid ${HAIRLINE_2};border-left:0;padding:14px 16px;font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:11px;color:${MUTED_2};">
          ${brandChip}${catChip ? '&nbsp;' + catChip : ''}
          &nbsp;<span style="color:${MUTED};">${outletAge}</span>
        </td>
        <td align="right" valign="top" style="font-size:11px;line-height:1;padding-top:2px;white-space:nowrap;">
          <span style="font-family:${FONT};font-size:9px;font-weight:bold;color:${MUTED_2};letter-spacing:1.5px;text-transform:uppercase;margin-right:5px;">SEV</span>${dots}
        </td>
      </tr></table>
      <div dir="auto" style="font-size:16px;font-weight:bold;line-height:1.35;color:${INK};padding-top:9px;">
        <a href="${esc(headlineHref)}" style="color:${INK};text-decoration:none;">${esc(it.headline)}</a>
      </div>
      <div style="font-size:11.5px;padding-top:6px;">${sentBadge} &nbsp; ${byline}</div>
      ${it.summary ? `<div dir="auto" style="font-size:13.5px;line-height:1.5;color:${MUTED};padding-top:8px;">${esc(it.summary)}</div>` : ''}
      ${it.pr_angle
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:11px;"><tr>
             <td width="3" bgcolor="${s.spine}" style="width:3px;background:${s.spine};font-size:0;line-height:0;">&nbsp;</td>
             <td bgcolor="${s.bg}" style="background:${s.bg};padding:9px 12px;">
               <div style="font-size:11px;font-weight:bold;letter-spacing:1.4px;color:${s.color};">REPUTATIONAL READ</div>
               ${renderAngleEmail(it.pr_angle, INK_SOFT)}
             </td>
           </tr></table>`
        : ''}
      ${coverageHtml(it._instances)}
      <div style="text-align:right;padding-top:10px;">
        <a href="${esc(boardItem)}" style="font-size:11px;color:${RED};text-decoration:none;font-weight:bold;letter-spacing:.3px;">Open on board →</a>
      </div>
    </td>
  </tr></table>`;
}

/* ============================================================
   Daily brief
   ============================================================ */

// Sentiment sections, negatives first and loudest.
const SENT_SECTIONS = [
  { key: 'negative', label: 'Negative — reputational risk', color: RED,       flag: '&#9888; ' },
  { key: 'positive', label: 'Positive — brand wins',        color: '#137a45', flag: '' },
  { key: 'neutral',  label: 'Neutral — market & announcements', color: '#4f5a67', flag: '' },
];

export function renderBulletin({ items, broken, scanned, greetingName, greeting, unclassified = 0 }) {
  const boardToken = process.env.RADAR_TOKEN;
  const boardBase = `${ORIGIN}/${boardToken ? `?t=${encodeURIComponent(boardToken)}` : ''}`;
  const dateLong = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Cairo',
  }).toUpperCase();
  const timeCairo = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo',
  });

  const negCount = items.filter((i) => i.sentiment === 'negative').length;
  const feedsLine = broken && broken.length
    ? `<span style="color:#ffdca8;">${broken.length} feed${broken.length === 1 ? '' : 's'} silent</span>`
    : `<span style="color:#ffd0d0;">all feeds live</span>`;

  const sectionsHtml = SENT_SECTIONS.map(({ key, label, color, flag }) => {
    const rows = items
      .filter((i) => (i.sentiment || 'neutral') === key)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
    if (!rows.length) return '';
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="padding:20px 0 8px;font-family:${FONT};font-size:13px;font-weight:bold;color:${color};">
        ${flag}${label}
        <span style="font-weight:normal;font-size:11px;color:${FAINT};">&nbsp;·&nbsp; ${rows.length} item${rows.length === 1 ? '' : 's'}</span>
      </td></tr>
      <tr><td style="border-top:1px solid ${HAIRLINE};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
    ${rows.map((r) => itemCardHtml(r, boardBase)).join('')}`;
  }).join('');

  const brokenFooter = broken && broken.length
    ? `<div style="padding-top:6px;color:#c0857e;">⚠ Feeds silent 24h+: ${broken.map((b) => esc(b.feed_id)).join(', ')}</div>`
    : '';

  // Classifier-failure note — same quiet diagnostic register as brokenFooter.
  // Only rendered when this run actually left items unclassified, so the
  // footer stays clean on a healthy day.
  const unclassifiedFooter = unclassified > 0
    ? `<div style="padding-top:6px;color:#c0857e;">⚠ ${unclassified} stor${unclassified === 1 ? 'y' : 'ies'} couldn't be auto-classified today — stored for review, not shown above.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>PR Radar — Daily Brief</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-collapse:collapse!important}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:${RED}}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:16px!important;padding-right:16px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${CANVAS};">
  ${items.length} brand item${items.length === 1 ? '' : 's'} today${negCount ? ` — ${negCount} negative.` : '.'}&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};">

  <tr><td bgcolor="${RED}" style="background:${RED};padding:20px 22px 15px;" class="px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td width="44" style="width:44px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="42" height="42" align="center" valign="middle" bgcolor="#ffffff" style="width:42px;height:42px;border-radius:11px;font-family:${FONT};font-size:14px;font-weight:bold;color:${RED};">PR</td>
        </tr></table>
      </td>
      <td style="padding-left:13px;font-family:${FONT};">
        <div style="font-size:21px;font-weight:bold;color:#ffffff;line-height:1.1;letter-spacing:-.3px;">PR Radar</div>
        <div style="font-size:10px;color:#ffd0d0;letter-spacing:1.5px;padding-top:4px;">BRAND &amp; REPUTATION &nbsp;·&nbsp; ${dateLong} &nbsp;·&nbsp; ${timeCairo} CAIRO</div>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>
      <td style="border-top:3px solid #ffffff;padding-top:12px;font-family:${FONT};font-size:11px;color:#ffc9c9;letter-spacing:.4px;">
        <strong style="color:#ffffff;">${items.length} item${items.length === 1 ? '' : 's'}</strong>
        &nbsp;·&nbsp; <strong style="color:#ffffff;">${negCount} negative</strong>
        &nbsp;·&nbsp; ${feedsLine}
      </td>
    </tr></table>
  </td></tr>

  ${greetingName ? `<tr><td bgcolor="${RED}" style="background:${RED};padding:16px 22px 18px;border-top:1px solid rgba(255,255,255,.2);" class="px">
    <div style="font-family:${FONT};font-size:22px;line-height:1.15;color:#ffffff;font-weight:700;letter-spacing:-.005em;margin:0 0 6px;">Hi ${esc(greetingName)},</div>
    <div style="font-family:${FONT};font-size:15px;line-height:1.5;color:#ffffff;font-weight:500;">Greetings — this is your daily brand &amp; reputation brief.</div>
  </td></tr>` : greeting ? `<tr><td bgcolor="${RED}" style="background:${RED};padding:14px 22px;border-top:1px solid rgba(255,255,255,.2);" class="px">
    <div style="font-family:${FONT};font-size:15px;line-height:1.5;color:#ffffff;font-weight:500;">${esc(greeting)}</div>
  </td></tr>` : ''}

  <tr><td bgcolor="#fbf0d9" style="background:#fbf0d9;border-bottom:1px solid #ecd9a6;padding:9px 22px;font-family:${FONT};" class="px">
    <div style="font-size:12px;line-height:1.5;color:#6b5836;"><strong style="color:#8a5a00;">Private — please don't forward.</strong> The board links below carry your personal access token.</div>
  </td></tr>

  <tr><td style="padding:6px 22px 8px;" class="px">
    ${legendStripHtml()}
    ${sectionsHtml || `<div style="padding:36px 0;font-family:${FONT};font-size:14px;color:${MUTED};text-align:center;">Nothing cleared screening today.<br>The feeds ran; there was no brand-relevant coverage.</div>`}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px;"><tr>
      <td align="center" bgcolor="${RED}" style="background:${RED};border-radius:9px;">
        <a href="${esc(boardBase)}" style="display:block;padding:13px 24px;font-family:${FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Open the board →</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td bgcolor="${PAPER_2}" style="background:${PAPER_2};padding:18px 22px 24px;font-family:${FONT};" class="px">
    <div style="font-size:11px;line-height:1.6;color:${MUTED_2};">
      Built for the PR &amp; Communications team · Vodafone Egypt.<br>
      Sent ${timeCairo} Cairo · pipeline scanned ${scanned || 0} items across all sources.
      ${unclassifiedFooter}
      ${brokenFooter}
    </div>
    <div style="padding-top:10px;font-size:11px;">
      <a href="${esc(boardBase)}" style="color:${RED};text-decoration:none;font-weight:bold;">Board</a>
    </div>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

/* ============================================================
   URGENT single-item reputational alert (severity 5)
   ============================================================ */

export function renderUrgent(item, boardUrl) {
  const token = process.env.RADAR_TOKEN;
  const withToken = (u) => token ? `${u}${u.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : u;
  const baseTarget = withToken(boardUrl || BOARD_LINK);
  const target = item.id ? `${baseTarget.replace(/#.*$/, '')}#item-${item.id}` : baseTarget;
  const timeCairo = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
  const s = sentOf(item);
  const brandChip = item.brand
    ? `<span style="background:${BRAND_COLOR[item.brand] || MUTED};color:#ffffff;font-weight:bold;padding:3px 8px;border-radius:5px;letter-spacing:.5px;">${esc(item.brand)}</span>`
    : '';
  const headlineHref = item.id ? `${ORIGIN}/api/go?id=${item.id}` : (item.url || target);

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>URGENT — PR Radar</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-collapse:collapse!important}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:${RED}}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:18px!important;padding-right:18px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#2a0606;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#2a0606;">
  URGENT · ${esc(item.brand || 'Brand')} — ${esc((item.headline || '').slice(0, 140))}&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#2a0606;">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};">

  <tr><td bgcolor="${RED}" style="background:${RED};padding:16px 22px 14px;border-top:5px solid ${OXBLOOD};" class="px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="font-family:${FONT};font-size:12px;font-weight:bold;color:#ffffff;letter-spacing:.5px;">PR&nbsp;RADAR</td>
      <td align="right" valign="middle" style="font-family:${FONT};">
        <span style="display:inline-block;background:${OXBLOOD};color:#ffffff;font-size:13px;font-weight:bold;letter-spacing:3px;padding:7px 14px;border-radius:6px;">● URGENT</span>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:13px;"><tr>
      <td style="border-top:3px solid #ffffff;padding-top:11px;font-family:${FONT};font-size:11px;line-height:1.5;color:#ffc9c9;letter-spacing:.4px;">
        Fired the hour a <strong style="color:#ffffff;">severity-5 reputational threat</strong> was detected · ${timeCairo} Cairo
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:24px 22px 8px;" class="px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${FONT};font-size:11px;color:${MUTED_2};">
        ${brandChip}
        <span style="padding-left:8px;">${esc(item.country || 'Egypt')}${item.source ? ' · ' + esc(item.source) : ''}</span>
        <span style="padding-left:8px;color:${s.color};font-weight:bold;text-transform:uppercase;">${s.label}</span>
      </td>
    </tr></table>

    <div dir="auto" style="font-family:${FONT};font-size:24px;font-weight:bold;line-height:1.28;color:${INK};letter-spacing:-.4px;padding-top:14px;">
      <a href="${esc(headlineHref)}" style="color:${INK};text-decoration:none;">${esc(item.headline)}</a>
    </div>
    <div style="font-family:${FONT};font-size:12px;color:${item.author ? INK_SOFT : MUTED_2};padding-top:8px;">${item.author ? 'By ' + esc(item.author) : 'Author —'}</div>

    ${item.summary ? `<div dir="auto" style="font-family:${FONT};font-size:14.5px;line-height:1.55;color:${INK_SOFT};padding-top:14px;">${esc(item.summary)}</div>` : ''}

    ${item.pr_angle
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
           <td width="4" bgcolor="${RED}" style="width:4px;background:${RED};font-size:0;line-height:0;">&nbsp;</td>
           <td bgcolor="${s.bg}" style="background:${s.bg};padding:14px 16px;font-family:${FONT};">
             <div style="font-size:12px;font-weight:bold;letter-spacing:1.4px;color:${RED};">WHY THIS NEEDS COMMS NOW</div>
             ${renderAngleEmail(item.pr_angle, INK_SOFT, 13.5)}
           </td>
         </tr></table>`
      : ''}
    ${coverageHtml(item._instances)}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 6px;"><tr>
      <td align="center" bgcolor="${RED}" style="background:${RED};border-radius:9px;">
        <a href="${esc(target)}" style="display:block;padding:14px 24px;font-family:${FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">Open on the board →</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td bgcolor="${PAPER_2}" style="background:${PAPER_2};padding:18px 22px 24px;font-family:${FONT};" class="px">
    <div style="font-size:11px;line-height:1.6;color:${MUTED_2};">
      Urgent alerts fire only for fresh, severity-5 reputational threats — checked hourly, silent otherwise.<br>
      Built for the PR &amp; Communications team · Vodafone Egypt.
    </div>
    <div style="padding-top:10px;font-size:11px;">
      <a href="${esc(target)}" style="color:${RED};text-decoration:none;font-weight:bold;">Board</a>
    </div>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

/* ============================================================
   Transport (Resend) — unchanged from the proven template
   ============================================================ */

// Split a comma-separated recipient string and drop empties. Accepts a string,
// an array, or null/undefined; always returns an array.
const parseAddrs = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
};

// Normalise an address to its bare, lower-cased email (handles "Name <email>").
const emailOf = (s) => {
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim().toLowerCase();
};

// Addresses that must never receive the silent BCC monitor copy. Override with
// RADAR_BCC_EXCLUDE (CSV); set it empty to disable the filter.
const BCC_EXCLUDE = new Set(
  parseAddrs(process.env.RADAR_BCC_EXCLUDE ?? '').map(emailOf)
);

export async function sendBulletin(html, subject, to, opts = {}) {
  const recipients = to ? parseAddrs(to) : parseAddrs(process.env.RADAR_TO);
  const bcc = parseAddrs(opts.bcc).filter((a) => !BCC_EXCLUDE.has(emailOf(a)));
  const body = { from: process.env.RADAR_FROM, to: recipients, subject, html };
  if (bcc.length) body.bcc = bcc;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
  return res.json();
}
