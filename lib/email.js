// Email templates — daily PR brief + URGENT single-item reputational alert.
// Table-based inline-styled HTML for Gmail / Outlook compatibility.
// Design system: Vodafone Egypt · PR & Communications (brand-adjacent).

import { recordAlert } from './db.js';
import { firstSafeUrl } from './safe-url.js';

export const esc = (s) =>
  String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Palette — the BOARD's design tokens (public/index.html :root), so the inbox
// and the app read as one product. Cool greys, not the warm/taupe set this
// file used to carry. Keep these in sync with the board when it changes.
const RED = '#e60000';
const RED_DEEP = '#b60009';       // board --red-deep
const OXBLOOD = '#3b434e';        // section-label ink (board --ink-2)
const INK = '#16191f';            // board --ink
const INK_SOFT = '#3b434e';       // board --ink-2
const MUTED = '#6c7480';          // board --muted
const MUTED_2 = '#9aa2ad';        // board --faint
const FAINT = '#9aa2ad';          // board --faint
const PAPER = '#ffffff';          // the email "page" = the board's card white
const PAPER_2 = '#f6f7f9';        // board --raise
const CANVAS = '#f1f2f5';         // board --bg
const CARD = '#ffffff';           // board --card
const HAIRLINE = '#e7e9ee';       // board --hair
const HAIRLINE_2 = '#e7e9ee';     // board --hair
const CHIP_BG = '#f0f3f7';        // board --neu-bg

// The board's system stack, with Arial last so Outlook/Word still resolves a
// sans face (Segoe UI is present on every modern Windows, so it lands there).
// NOTE the single quotes around Segoe UI: these styles live inside
// double-quoted style="" attributes, so a double quote here truncates every
// declaration after it (it silently killed colours + weights when first added).
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Sentiment system — the heart of a PR read. Negative is loud (red, tinted
// card); positive is green; neutral is a calm slate. Kept in sync with the
// board so email and board read as one design.
// Tinted pill + hairline, exactly like the board's .sent chip. `line` doubles
// as the card's border colour so a negative card reads the same in both places.
const SENT = {
  negative: { label: 'Negative', color: RED_DEEP, spine: RED, bg: '#fff2f0', line: '#ffd4cf',
              pill: 'color:#b60009;background:#fff2f0;border:1px solid #ffd4cf' },
  positive: { label: 'Positive', color: '#0f9d58', spine: '#0f9d58', bg: '#edfaf1', line: '#c3e9d1',
              pill: 'color:#0f9d58;background:#edfaf1;border:1px solid #c3e9d1' },
  neutral:  { label: 'Neutral',  color: '#5b6675', spine: '#9aa4b0', bg: '#f0f3f7', line: '#e0e6ec',
              pill: 'color:#5b6675;background:#f0f3f7;border:1px solid #e0e6ec' },
};
const sentOf = (it) => SENT[it && it.sentiment] || SENT.neutral;
// Sentiment reads the same way on every brand: how the story lands for the brand
// it is ABOUT. A rival's win is "Positive" (positive for them), a rival's outage
// "Negative" — no inversion, no per-brand relabelling. What the item means for
// Vodafone is carried by severity and by the lane, not by the pill.
const sentLabel = (it) => sentOf(it).label;
// Which section an item files under (what WE do about it), distinct from its own
// sentiment. The action sections — "reputational risk" and "brand wins" — are
// Vodafone-only; a competitor's story is market intel, so it lands in the market
// (neutral) section regardless of its sentiment. The card keeps its true pill.
const laneKey = (it) => {
  const s = it && SENT[it.sentiment] ? it.sentiment : 'neutral';
  return (it && it.brand) === 'Vodafone' ? s : 'neutral';
};

// Brand chip colours — the four tracked brands + a market catch-all.
// These MUST match public/index.html's BRAND_COLOR: the chip is the same object
// in the inbox and on the board, so a reader tapping through must not see the
// colour change under them.
// `market` was #6d605d and `WE` #6a1b9a here while the board had #6c7480 and
// #7b1fa2 — a drift that survived because no email test rendered either brand,
// and #6d605d is on render-email-design's own retired-warm-palette blocklist.
// The redesign puts the market chip on a card for the first time, which is what
// finally made it visible. Corrected to the board's values.
const BRAND_COLOR = {
  Vodafone: RED, Orange: '#ff7900', WE: '#7b1fa2', 'e&': '#00857b', market: '#6c7480',
};

// The email design tokens, bundled for other renderers (the weekly/monthly
// report in lib/report.js) so a second surface can't drift from this one.
// Additive — nothing here changes how the bulletin/urgent templates render.
export const THEME = {
  RED, RED_DEEP, OXBLOOD, INK, INK_SOFT, MUTED, MUTED_2, FAINT,
  PAPER, PAPER_2, CANVAS, CARD, HAIRLINE, HAIRLINE_2, CHIP_BG, FONT, BRAND_COLOR,
};

// Severity ramp (importance 1..5) — reputational reach/impact, distinct hues.
const IMP = { 5: RED, 4: '#f27100', 3: '#e2a900', 2: '#3a7ac2', 1: '#8a807d' };
// The unfilled dash is the board's hairline. It was #d9cdca — a warm taupe left
// over from the retired palette, and the one place it still showed.
const IMP_EMPTY = HAIRLINE;

const IMP_LABEL = { 5: 'Crisis', 4: 'High', 3: 'Watch', 2: 'Low', 1: 'Info' };

const impLevel = (imp) => Math.max(1, Math.min(5, imp || 1));

// The three lanes, as DESIGN: heading dot, panel tint, divider line. Distinct
// from SENT (the pill), because the negative LANE is the full red #e60000 while
// a negative PILL is the deeper #b60009 that reads on a tinted background.
const LANE = {
  negative: { color: RED,       bg: '#fff2f0', line: '#ffd4cf' },
  positive: { color: '#0f9d58', bg: '#edfaf1', line: '#c3e9d1' },
  neutral:  { color: '#5b6675', bg: '#f0f3f7', line: '#e0e6ec' },
};
const laneOf = (it) => LANE[laneKey(it)] || LANE.neutral;

// Board / share origin from BOARD_URL (falls back to a placeholder domain).
const RAW_BOARD_URL = process.env.BOARD_URL || 'https://pr-radar.example.com/';
const ORIGIN = RAW_BOARD_URL.split('?')[0].replace(/\/+$/, '');
const BOARD_LINK = RAW_BOARD_URL;

/* ============================================================
   Shared helpers
   ============================================================ */

// Impact as five fat dashes rather than 9px dots. The dots were the single most
// common "I can't read this on my phone" complaint: at arm's length, five 9px
// circles two shades apart are one smudge. 16×7px reads as a filled/empty bar.
// font-size:0 on the wrapper kills the whitespace between the inline-blocks,
// which otherwise renders as a ragged gap in Outlook.
function impactDashes(imp) {
  const n = impLevel(imp);
  const dash = (bg) =>
    `<span style="display:inline-block;width:16px;height:7px;border-radius:4px;margin-right:4px;background:${bg};"></span>`;
  return `<span style="white-space:nowrap;font-size:0;line-height:0;">${dash(IMP[n]).repeat(n)}${dash(IMP_EMPTY).repeat(5 - n)}</span>`;
}

// "Impact 4 · High" — the number AND the word. A colour ramp alone is not
// readable to the ~8% of men with a colour vision deficiency, and orange-vs-red
// at 7px is exactly the pair that goes.
function impactWordCell(imp) {
  const n = impLevel(imp);
  return `<td valign="middle" style="font-size:11px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;color:${IMP[n]};white-space:nowrap;">Impact ${n} · ${IMP_LABEL[n]}</td>`;
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
// Parse the classifier's labelled pr_angle into [{label, val}]. Generic over the
// label names on purpose — a hard-coded Read/Audience/Action parser silently
// drops a line the day the prompt grows a fourth one.
function angleLines(text) {
  const src = String(text || '').trim();
  if (!src) return { lines: [], raw: '' };
  const lines = [];
  for (const raw of src.split(/\r?\n+/)) {
    const m = raw.trim().match(/^([A-Za-z][A-Za-z /&]*?)\s*[·:\-–—]\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    if (!val || /^[—–\-·.\s]*$/.test(val)) continue;
    lines.push({ label: m[1].trim(), val });
  }
  return { lines, raw: src };
}

// Which line is the ACTION — the one the redesign promotes. Labelled `Action`
// when the classifier behaves; otherwise the LAST line, which is where the
// prompt puts it. Never guesses past that: with nothing parseable the caller
// falls back to the raw paragraph.
const actionIndex = (lines) => {
  const i = lines.findIndex((l) => /^action$/i.test(l.label));
  return i >= 0 ? i : lines.length - 1;
};

// Hero + alert shape: every line as a stacked row, label above value, hairline
// between. The Action row is the loud one — lane-coloured label, ink value at
// 600 — because promoting the action above the reasoning is the whole redesign.
function angleRowsHtml(lines, { divider, actionColor, pad = 8 }) {
  const ai = actionIndex(lines);
  return lines.map((l, i) => {
    const last = i === lines.length - 1;
    const isAction = i === ai;
    return `<div style="padding:${pad}px 0;${last ? '' : `border-bottom:1px solid ${divider};`}">
          <div style="font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${isAction ? actionColor : MUTED_2};padding-bottom:4px;">${esc(l.label)}</div>
          <div dir="auto" style="font-size:15px;line-height:1.55;color:${isAction ? INK : INK_SOFT};font-weight:${isAction ? 600 : 400};">${esc(l.val)}</div>
        </div>`;
  }).join('\n        ');
}

// Standard-card shape: the action alone under "Do this", then a hairline, then
// the reasoning demoted beneath it. `Read` is relabelled `Why:` here only — the
// hero keeps the classifier's own word. Any line the classifier adds beyond the
// three lands below the divider rather than being dropped.
const SUB_LABEL = { read: 'Why' };
function doThisHtml(angle, lane) {
  const { lines, raw } = angleLines(angle);
  if (!lines.length) {
    if (!raw) return '';
    return panel(lane, `<div dir="auto" style="font-size:15px;line-height:1.55;color:${INK};font-weight:600;">${esc(raw)}</div>`);
  }
  const ai = actionIndex(lines);
  const action = lines[ai];
  const rest = lines.filter((_, i) => i !== ai);
  const sub = rest.map((l, i) => {
    const label = SUB_LABEL[l.label.toLowerCase()] || l.label;
    return `<div dir="auto" style="font-size:13.5px;line-height:1.55;color:${INK_SOFT};${i ? 'padding-top:7px;' : ''}"><strong style="color:${MUTED};font-weight:700;">${esc(label)}: </strong>${esc(l.val)}</div>`;
  }).join('\n            ');
  const body = `<div dir="auto" style="font-size:15px;line-height:1.55;color:${INK};font-weight:600;">${esc(action.val)}</div>`
    + (rest.length ? `
          <div style="padding-top:12px;border-top:1px solid ${lane.line};margin-top:12px;">
            ${sub}
          </div>` : '');
  return panel(lane, body);
}
function panel(lane, body) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
        <td bgcolor="${lane.bg}" style="background:${lane.bg};border-radius:14px;padding:15px 17px;">
          <div style="font-size:9.5px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;color:${lane.color};padding-bottom:6px;">Do this</div>
          ${body}
        </td>
      </tr></table>`;
}

// The coverage list — every outlet that ran the story, with its byline. This is
// the PR payload: who published it, and everywhere it appeared. Only shown when
// there's more than one instance (the header already names the primary outlet).
// Mirrors the board's uniqOutlets(): count OUTLETS, not stored rows. The same
// article arrives twice (Google-News redirect + resolved link), and counting
// rows made a card claim more outlets than actually ran the story.
function uniqOutlets(insts) {
  const list = Array.isArray(insts) ? insts.filter((x) => x && (x.outlet || x.url)) : [];
  const by = new Map();
  const gn = (u) => (/news\.google\.com/.test(String(u || '')) ? 1 : 0);
  for (const x of list) {
    const key = String(x.outlet || x.url || '').trim().toLowerCase();
    if (!key) continue;
    const cur = by.get(key);
    if (!cur) { by.set(key, x); continue; }
    // Best of both: publisher link + whichever row carries the byline.
    const primary = gn(cur.url) !== gn(x.url) ? (gn(cur.url) < gn(x.url) ? cur : x) : (cur.url ? cur : x);
    const other = primary === cur ? x : cur;
    by.set(key, { ...primary, author: primary.author || other.author || null });
  }
  return [...by.values()];
}
function coverageHtml(insts) {
  const list = uniqOutlets(insts);
  if (list.length < 2) return '';
  const rows = list.slice(0, 12).map((x) => {
    const name = esc(x.outlet || '—');
    const href = firstSafeUrl(x.url);
    const linked = href ? `<a href="${esc(href)}" style="color:${INK_SOFT};text-decoration:none;font-weight:600;">${name}</a>` : `<span style="font-weight:600;">${name}</span>`;
    const by = x.author ? ` <span style="color:${MUTED_2};">· ${esc(x.author)}</span>` : '';
    return `<div dir="auto" style="font-size:11.5px;line-height:1.5;color:${INK_SOFT};padding:1px 0;">${linked}${by}</div>`;
  }).join('');
  const more = list.length > 12 ? `<div style="font-size:11px;color:${MUTED_2};padding-top:2px;">+${list.length - 12} more outlet${list.length - 12 === 1 ? '' : 's'}</div>` : '';
  // Kept through the redesign on purpose. It is absent from the design targets
  // only because none of the five sample stories had run in more than one
  // outlet — coverageHtml renders nothing below two. Who else picked the story
  // up IS the PR payload, so it survives, restyled to the new panel radius.
  return `
  <div style="margin-top:16px;padding:12px 15px;background:${PAPER_2};border:1px solid ${HAIRLINE};border-radius:14px;font-family:${FONT};">
    <div style="font-size:9.5px;font-weight:bold;letter-spacing:.16em;color:${MUTED_2};text-transform:uppercase;padding-bottom:6px;">Coverage · ${list.length} outlet${list.length === 1 ? '' : 's'}</div>
    ${rows}${more}
  </div>`;
}

// Attribution that is never blank: the person byline when we have one, else the
// publication's newsroom (unbylined copy is desk-written — that IS the author).
// Display-only: nothing is written back, so journalist analytics stay clean.
// `outlet · age · byline`.
//
// dir="auto" takes the FIRST strong character and sets the direction of the
// WHOLE node — so a meta line mixing an Arabic outlet with a Latin age reorders
// and the separators land at the wrong end. Each single-language run is fenced
// on its own and the separators stay outside. `By {name}` is deliberately one
// run: the Latin "By" fixes the base direction and an Arabic name renders RTL
// inside it, which is what a reader expects.
//
// The byline appears ONLY when a person wrote the piece. The board's "<Outlet>
// · newsroom" fallback is right THERE, where `.by` is a field of its own, but
// here the outlet already opens the line — "Masrawy · 2d ago · Masrawy ·
// newsroom" names it twice and reads as a rendering bug. Nothing is invented
// either way, which is the actual rule; an absent byline is simply absent.
function metaHtml(it) {
  const bits = [];
  if (it.source) bits.push(`<span dir="auto">${esc(it.source)}</span>`);
  const age = ageLabel(it);
  if (age) bits.push(esc(age));
  if (it.author) bits.push(`<span dir="auto">By ${esc(it.author)}</span>`);
  // Unwrapped: the caller owns the colour, because the card puts it on a span
  // beside the sentiment pill and the alert puts it on the surrounding div.
  return bits.join(' · ');
}

const sentPill = (it) => {
  const s = sentOf(it);
  return `<span style="display:inline-block;font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:4px;${s.pill};">${esc(sentLabel(it))}</span>`;
};

const goHref = (it) => (it.id ? `${ORIGIN}/api/go?id=${it.id}` : (firstSafeUrl(it.url) || BOARD_LINK));

export function itemCardHtml(it, boardBase) {
  const lane = laneOf(it);
  const brandChip = it.brand
    ? `<span style="background:${BRAND_COLOR[it.brand] || MUTED};color:#ffffff;font-weight:bold;padding:3px 9px;border-radius:7px;font-size:10px;letter-spacing:.02em;">${esc(it.brand)}</span>`
    : '';
  const boardItem = it.id ? `${boardBase}#item-${it.id}` : boardBase;
  // /api/go when the card is stored (short, branded, decodes the wrapper); the
  // raw URL only as a fallback, and only if it passes the scheme check — an
  // href is a destination, and esc() does nothing to `javascript:`.
  // Card chrome: white on the board's hairline. The sentiment used to tint the
  // BORDER; it now reads from the pill and the Do-this panel, so the lane tint
  // sits where the reader is looking rather than around the edge.
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;"><tr>
    <td bgcolor="${CARD}" style="background:${CARD};border:1px solid ${HAIRLINE};border-radius:18px;padding:20px;font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle" style="padding-right:10px;">${impactDashes(it.importance)}</td>
        <td align="right" valign="middle" style="font-size:11px;color:${MUTED_2};white-space:nowrap;">${brandChip}</td>
      </tr></table>
      <div dir="auto" style="font-size:19px;font-weight:bold;line-height:1.34;letter-spacing:-.2px;color:${INK};padding-top:14px;">
        <a href="${esc(goHref(it))}" style="color:${INK};text-decoration:none;">${esc(it.headline)}</a></div>
      <div style="font-size:13px;padding-top:11px;">${sentPill(it)} &nbsp; <span style="color:${MUTED};">${metaHtml(it)}</span></div>
      ${it.summary ? `<div dir="auto" style="font-size:15.5px;line-height:1.6;color:${INK_SOFT};padding-top:12px;">${esc(it.summary)}</div>` : ''}
      ${doThisHtml(it.pr_angle, lane)}
      ${coverageHtml(it._instances)}
      <div style="padding-top:14px;"><a href="${esc(boardItem)}" style="font-size:14px;color:${RED};text-decoration:none;font-weight:bold;">Open on board →</a></div>
    </td>
  </tr></table>`;
}

// The one story to read if you read nothing else — lifted out of "Needs a
// response" and given the lane tint, a bigger headline and its own CTA. The
// lane it came from then says "N more, after the one above" so the section
// counts still reconcile with the total in the intro.
function heroCardHtml(it, boardBase) {
  const lane = laneOf(it);
  const { lines, raw } = angleLines(it.pr_angle);
  const angle = lines.length
    ? angleRowsHtml(lines, { divider: '#eef0f3', actionColor: lane.color })
    : (raw ? `<div dir="auto" style="font-size:15px;line-height:1.55;color:${INK};font-weight:600;">${esc(raw)}</div>` : '');
  const boardItem = it.id ? `${boardBase}#item-${it.id}` : boardBase;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;"><tr>
    <td bgcolor="${lane.bg}" style="background:${lane.bg};border:1px solid ${lane.line};border-radius:18px;padding:22px;font-family:${FONT};">
      <div style="font-size:10px;font-weight:bold;letter-spacing:.18em;text-transform:uppercase;color:${lane.color};padding-bottom:14px;">Read this first</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr>
        <td valign="middle" style="padding-right:10px;">${impactDashes(it.importance)}</td>
        ${impactWordCell(it.importance)}
      </tr></table>
      <div dir="auto" style="font-size:23px;font-weight:bold;line-height:1.3;letter-spacing:-.3px;color:${INK};">
        <a href="${esc(goHref(it))}" style="color:${INK};text-decoration:none;">${esc(it.headline)}</a></div>
      <div style="font-size:13px;padding-top:12px;">${sentPill(it)} &nbsp; <span style="color:${MUTED};">${metaHtml(it)}</span></div>
      ${it.summary ? `<div dir="auto" style="font-size:16px;line-height:1.6;color:${INK_SOFT};padding-top:14px;">${esc(it.summary)}</div>` : ''}
      ${angle ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
        <td bgcolor="${PAPER}" style="background:${PAPER};border-radius:14px;padding:16px 18px;">
          <div style="font-size:10px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;color:${MUTED_2};padding-bottom:10px;">What to do with this</div>
          ${angle}
        </td>
      </tr></table>` : ''}
      ${coverageHtml(it._instances)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
        <td align="center" bgcolor="${lane.color}" style="background:${lane.color};border-radius:12px;">
          <a href="${esc(boardItem)}" style="display:block;padding:15px 20px;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Open on the board →</a>
        </td>
      </tr></table>
    </td>
  </tr></table>`;
}

/* ============================================================
   Daily brief
   ============================================================ */

// Sentiment sections, negatives first and loudest.
// Lane names are the BOARD's, verbatim — the same three sections a reader sees
// when they tap through, so the email and the app describe the day identically.
const SENT_SECTIONS = [
  { key: 'negative', label: 'Needs a response' },
  { key: 'positive', label: 'Wins to amplify' },
  { key: 'neutral',  label: 'Market & noted' },
];

// Freshest first among equals — `ageLabel` reads the same two fields.
const whenOf = (it) => new Date(it.published_at || it.seen_at || 0).getTime() || 0;

/**
 * The one story to lift above the lanes. Highest Impact inside "Needs a
 * response", ties broken by recency. Returns null when that lane is empty —
 * there is no hero on a day with nothing to respond to, and every lane then
 * reports its plain count.
 */
export function pickHero(items) {
  const lane = (items || []).filter((i) => laneKey(i) === 'negative');
  if (!lane.length) return null;
  return lane.slice().sort((a, b) =>
    (b.importance || 0) - (a.importance || 0) || whenOf(b) - whenOf(a))[0];
}

export function renderBulletin({ items, broken, scanned, greetingName, unclassified = 0, variant }) {
  // No ?t= on board links — the board ignores it now (Bearer-session auth); it
  // was only a leak surface in every emailed link. Item cards below use
  // boardBase + #item-<id>, which still deep-links without a token.
  const boardBase = `${ORIGIN}/`;
  const timeCairo = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
  const dateCairo = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'Africa/Cairo',
  });
  // `variant:'admin'` is the RADAR_TO/team copy. It used to be passed and never
  // read; it now decides the two things only the team should see — the private
  // notice and the footer diagnostics naming internal feed ids.
  const isTeam = variant === 'admin';
  // A subscriber can have a name too, so the greeting is not what separates the
  // copies. Falls back to the plain form rather than inventing a name.
  const name = String(greetingName || '').trim();

  const negCount = items.filter((i) => i.sentiment === 'negative').length;
  const winCount = items.filter((i) => i.sentiment === 'positive').length;

  // The ONLY place a reader learns the radar was partially blind. Both copies
  // get it: subscribers are told the sweep was narrow, the team also gets the
  // feed names in the footer.
  const silent = (broken && broken.length) || 0;
  const feedClause = silent
    ? `${silent === 1 ? 'One feed is' : `${silent} feeds are`} silent, so today's sweep is slightly narrower than usual.`
    : "All feeds are live, so today's sweep is complete.";

  const tally = [
    negCount ? `<strong style="color:${RED};">${negCount} negative</strong>` : null,
    winCount ? `<strong style="color:#0f9d58;">${winCount} win${winCount === 1 ? '' : 's'}</strong>` : null,
  ].filter(Boolean);
  const summarySentence = `<strong style="color:${INK};">${items.length} item${items.length === 1 ? '' : 's'}</strong> on the radar today${tally.length ? ' — ' + tally.join(', ') : ''}. ${feedClause}`;
  const preheader = `Good morning — ${items.length} item${items.length === 1 ? '' : 's'} today${negCount ? `, ${negCount} negative` : ''}${winCount ? `, ${winCount} win${winCount === 1 ? '' : 's'}` : ''}.`;

  const hero = pickHero(items);
  const heroHtml = hero ? heroCardHtml(hero, boardBase) : '';

  const sectionsHtml = SENT_SECTIONS.map(({ key, label }) => {
    const lane = LANE[key];
    const rows = items
      .filter((i) => laneKey(i) === key && i !== hero)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || whenOf(b) - whenOf(a));
    const fromHero = hero && laneKey(hero) === key;
    // An empty lane is omitted — but the lane the HERO came from still gets its
    // heading even with nothing left to list. The lane names are shared with the
    // board and the guide, and on a day with exactly one story to respond to the
    // hero would otherwise consume the whole lane and the words "Needs a
    // response" would never appear at all.
    if (!rows.length && !fromHero) return '';
    const count = !rows.length
      ? 'just the one above'
      : fromHero
        ? `${rows.length} more, after the one above`
        : `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    return `<div style="font-family:${FONT};font-size:13px;font-weight:bold;color:${INK};padding:26px 4px 12px;">
    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${lane.color};margin-right:9px;"></span>${esc(label)}
    <span style="font-weight:normal;color:${MUTED_2};">&nbsp;·&nbsp; ${count}</span></div>
  ${rows.map((r) => itemCardHtml(r, boardBase)).join('')}`;
  }).join('');

  // Team copy only: a subscriber has no use for an internal feed id, and the
  // summary sentence has already told them the sweep was narrow.
  const brokenFooter = isTeam && silent
    ? `<div style="padding-top:6px;color:#c0857e;">⚠ Feeds silent 24h+: ${broken.map((b) => esc(b.feed_id)).join(', ')}</div>`
    : '';

  // Classifier-failure note — same quiet diagnostic register as brokenFooter.
  // Only rendered when this run actually left items unclassified, so the
  // footer stays clean on a healthy day.
  const unclassifiedFooter = unclassified > 0
    ? `<div style="padding-top:8px;color:#c0857e;">⚠ ${unclassified} stor${unclassified === 1 ? 'y' : 'ies'} couldn't be auto-classified today — stored for review, not shown above.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
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
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${CANVAS};">${esc(preheader)}&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};">

  <tr><td style="padding:32px 22px 0;font-family:${FONT};" class="px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" width="34" style="width:34px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="30" height="30" align="center" valign="middle" bgcolor="${RED}" style="width:30px;height:30px;background:${RED};border-radius:9px;font-size:11px;font-weight:bold;color:#ffffff;">PR</td></tr></table>
      </td>
      <td valign="middle" style="font-size:13px;font-weight:bold;letter-spacing:.04em;color:${INK};">PR Radar <span style="font-weight:normal;color:${MUTED_2};">&nbsp;·&nbsp; ${esc(dateCairo)}, ${esc(timeCairo)} Cairo</span></td>
    </tr></table>
    <div style="font-size:30px;font-weight:bold;line-height:1.15;letter-spacing:-.7px;color:${INK};padding:22px 0 12px;">Good morning${name ? `, ${esc(name)}` : ''}.</div>
    <div style="font-size:17px;line-height:1.6;color:${INK_SOFT};padding-bottom:8px;">
      ${summarySentence}</div>
    ${isTeam
      ? `<div style="font-size:13px;line-height:1.55;color:${MUTED_2};padding:10px 0 22px;"><strong style="color:#8a5a00;">Private — please don't forward.</strong></div>`
      : `<div style="height:22px;font-size:0;line-height:0;">&nbsp;</div>`}
  </td></tr>
  <tr><td style="padding:0 22px 8px;" class="px">
    ${heroHtml}${sectionsHtml || (heroHtml ? '' : `<div style="padding:36px 0;font-family:${FONT};font-size:14px;color:${MUTED};text-align:center;">Nothing cleared screening today.<br>The feeds ran; there was no brand-relevant coverage.</div>`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 10px;"><tr>
      <td align="center" bgcolor="${INK}" style="background:${INK};border-radius:14px;">
        <a href="${esc(boardBase)}" style="display:block;padding:18px 24px;font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">Open the board →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="${PAPER_2}" style="background:${PAPER_2};padding:22px 22px 28px;font-family:${FONT};" class="px">
    <div style="font-size:12px;line-height:1.7;color:${MUTED_2};">Built for the PR &amp; Communications team · Vodafone Egypt.<br>Sent ${esc(timeCairo)} Cairo · pipeline scanned ${scanned || 0} items across all sources.${unclassifiedFooter}${brokenFooter}</div>
    <div style="padding-top:14px;font-size:12px;">
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
   Instant single-item alert (Impact 4-5, or any negative story about one
   of the four tracked operators)
   ============================================================ */

/**
 * Does this story warrant an alert the moment it lands, rather than waiting for
 * the 05:00 brief? Impact 4-5, or ANY negative operator story regardless of
 * Impact — a negative story about us is worth knowing within the quarter hour
 * even when its pickup is small.
 *
 * Sentiment is the story's own tone for the brand it names, so this deliberately
 * checks brand === 'Vodafone': a negative story about a rival is THEIR problem
 * and rides the Impact test instead (it only alerts if it also scores 4+).
 */
/** The four tracked operators. A negative story about ANY of them alerts —
    `market` and an unbranded item do not, since neither names an operator the
    team can act on. */
export const TRACKED_OPERATORS = ['Vodafone', 'Orange', 'WE', 'e&'];

export function isInstantAlert(item) {
  return (item.importance || 0) >= 4
    || (TRACKED_OPERATORS.includes(item.brand) && item.sentiment === 'negative');
}

/**
 * How loudly to say it. Impact 5 is a crisis; an Impact-4 story or a quiet
 * negative mention is worth the interruption but is not a five-alarm fire, and
 * labelling everything URGENT is how an alert channel earns being ignored.
 * api/radar.js builds the email subject from this too, so the badge in the
 * header and the subject in the inbox can never drift apart.
 */
export function urgentTier(item) {
  const imp = item.importance || 0;
  // `lead` opens the header's "why this fired" sentence; renderUrgent completes
  // it with the brand and the 15-minute clause. It lives here, beside the rule
  // that fires the alert, so the trigger and the words describing it cannot
  // drift apart — the same reason `label` does.
  // The brand is NOT in this string: it is named by renderUrgent, which styles
  // it differently per tier (white on the red URGENT header, red on the white
  // ALERT one). Naming it remains non-negotiable — since rivals' negatives
  // alert too, the reader must be able to tell a competitor's problem from ours
  // without reading past the header.
  if (imp >= 5) return { label: 'URGENT', lead: 'An Impact-5 story is running' };
  return { label: 'ALERT', lead: 'A story we should look at is running' };
}

export function renderUrgent(item, boardUrl) {
  const tier = urgentTier(item);
  // No ?t= — the board ignores it now (Bearer-session auth); it was only a leak
  // surface. The #item-<id> anchor still deep-links.
  const baseTarget = boardUrl || BOARD_LINK;
  const target = item.id ? `${baseTarget.replace(/#.*$/, '')}#item-${item.id}` : baseTarget;
  const timeCairo = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
  const urgent = tier.label === 'URGENT';
  // The panel takes the story's OWN sentiment, not its lane: an alert can fire
  // for a rival's negative story (lane = market) and for an Impact-4 win, and a
  // red "why this needs comms now" over a win reads as a crisis that isn't one.
  const tone = LANE[item.sentiment] || LANE.neutral;
  // URGENT is a red header with a white badge; ALERT is a white header with a
  // slate badge. Keeping them visually distinct is the point — labelling
  // everything URGENT is how an alert channel earns being ignored.
  const headerBg = urgent ? RED : PAPER;
  const accent = urgent ? RED : OXBLOOD;
  const metaCol = urgent ? '#ffd0d0' : MUTED_2;
  const badge = urgent
    ? `background:#ffffff;color:${RED}`
    : `background:${OXBLOOD};color:#ffffff`;
  // Name the brand so a reader can tell a competitor's problem from ours in the
  // header, before they have read a word of the story.
  const brandSpan = item.brand
    ? ` about <span style="color:${urgent ? '#ffffff' : RED};font-weight:bold;">${esc(item.brand)}</span>`
    : '';
  const whyFired = `${tier.lead}${brandSpan} — flagged within 15 minutes.`;
  const { lines: angleParsed, raw: angleRaw } = angleLines(item.pr_angle);
  const angleBody = angleParsed.length
    ? angleRowsHtml(angleParsed, { divider: tone.line, actionColor: tone.color, pad: 9 })
    : (angleRaw ? `<div dir="auto" style="font-size:15px;line-height:1.55;color:${INK};font-weight:600;">${esc(angleRaw)}</div>` : '');
  const headlineHref = item.id ? `${ORIGIN}/api/go?id=${item.id}` : (firstSafeUrl(item.url) || target);

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${tier.label} — PR Radar</title>
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
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${CANVAS};">${tier.label} · ${esc(item.brand || 'Brand')} — ${esc((item.headline || '').slice(0, 140))}&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${PAPER};">

  <tr><td bgcolor="${headerBg}" style="background:${headerBg};padding:26px 22px 24px;border-top:6px solid ${accent};font-family:${FONT};" class="px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="font-size:12px;font-weight:bold;letter-spacing:.2em;color:${metaCol};">PR RADAR</td>
      <td align="right" valign="middle" style="font-size:11px;color:${metaCol};">${esc(timeCairo)} Cairo</td>
    </tr></table>
    <div style="padding-top:20px;">
      <span style="display:inline-block;${badge};font-size:15px;font-weight:bold;letter-spacing:.28em;padding:11px 20px;border-radius:10px;">${tier.label}</span>
    </div>
    <div style="font-size:${urgent ? 19 : 18}px;line-height:1.5;color:${urgent ? '#ffffff' : INK};font-weight:600;padding-top:18px;">
      ${whyFired}</div>
  </td></tr>
  <tr><td style="padding:26px 22px 0;font-family:${FONT};" class="px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr>
      <td valign="middle" style="padding-right:10px;">${impactDashes(item.importance)}</td>
      ${impactWordCell(item.importance)}
      <td valign="middle" style="padding-left:12px;">${sentPill(item)}</td>
    </tr></table>
    <div dir="auto" style="font-size:26px;font-weight:bold;line-height:1.28;letter-spacing:-.5px;color:${INK};">
      <a href="${esc(headlineHref)}" style="color:${INK};text-decoration:none;">${esc(item.headline)}</a></div>
    <div style="font-size:13px;color:${MUTED};padding-top:12px;">${metaHtml(item)}</div>
    ${item.summary ? `<div dir="auto" style="font-size:16px;line-height:1.62;color:${INK_SOFT};padding-top:16px;">${esc(item.summary)}</div>` : ''}

    ${angleBody ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr>
      <td bgcolor="${tone.bg}" style="background:${tone.bg};border:1px solid ${tone.line};border-radius:18px;padding:20px;">
        <div style="font-size:10px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;color:${tone.color};padding-bottom:12px;">Why this needs comms now</div>
        ${angleBody}
      </td>
    </tr></table>` : ''}
    ${coverageHtml(item._instances)}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 10px;"><tr>
      <td align="center" bgcolor="${urgent ? RED : INK}" style="background:${urgent ? RED : INK};border-radius:14px;">
        <a href="${esc(target)}" style="display:block;padding:18px 24px;font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">Open on the board →</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="${PAPER_2}" style="background:${PAPER_2};padding:22px 22px 28px;font-family:${FONT};" class="px">
    <div style="font-size:12px;line-height:1.7;color:${MUTED_2};">
      Instant alerts fire for fresh stories at Impact 4-5, and for any negative story about Vodafone, Orange, WE or e&amp; — checked every 15 minutes, silent otherwise.<br>Built for the PR &amp; Communications team · Vodafone Egypt.</div>
    <div style="padding-top:14px;font-size:12px;">
      <a href="${esc(`${ORIGIN}/`)}" style="color:${RED};text-decoration:none;font-weight:bold;">Board</a>
    </div>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

/* ============================================================
   Welcome / sign-in email — one per person, sent when their
   account is created in Admin → Users.
   ============================================================ */

/** The address a stuck user should write to. NOT "reply to this email": replies
    land on RADAR_FROM, the radar's sending address, which nobody reads — so a
    stuck person's message would go nowhere. The admin who created the account is
    the right human, and `api/admin.js` passes their address; these env vars are
    the fallback for a token-driven call that has no address of its own. */
export const SUPPORT_EMAIL = () =>
  (process.env.RADAR_SUPPORT_EMAIL || parseAddrs(process.env.OPS_ALERT_TO || process.env.RADAR_TO)[0] || '')
    .toString().trim();

/** The per-person sign-in email. Deliberately PERSONAL: each recipient sees only
    their OWN address and password. The temporary password is random and
    single-purpose, but it is still a live credential — which is why this is
    never sent to a group and never re-sent to someone who already has a
    password of their own.
    `subscribed` decides which inbox promise is made, so nobody is told a daily
    brief is coming when they aren't on the list. */
export function renderWelcome({ name, email, password, role = 'viewer', boardUrl, support, subscribed = false } = {}) {
  const helpTo = (support || SUPPORT_EMAIL() || '').trim();
  const origin = (boardUrl || BOARD_LINK || ORIGIN).split('?')[0].replace(/\/+$/, '');
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const isAdmin = role === 'admin';
  const row = (label, value) => `
    <tr>
      <td style="padding:9px 0 0;font-family:${FONT};font-size:11px;color:${MUTED};
                 letter-spacing:.06em;text-transform:uppercase;width:86px;" valign="top">${esc(label)}</td>
      <td style="padding:9px 0 0;font-family:'Courier New',Courier,monospace;font-size:15px;
                 font-weight:bold;color:${INK};word-break:break-all;">${esc(value)}</td>
    </tr>`;
  const bullet = (html) => `&bull; ${html}<br>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your PR Radar sign-in</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${CARD};border:1px solid ${HAIRLINE};border-radius:14px;overflow:hidden;">

  <tr><td bgcolor="${RED}" style="background:${RED};padding:20px 26px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td width="44" style="width:44px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="42" height="42" align="center" valign="middle" bgcolor="#ffffff" style="width:42px;height:42px;border-radius:11px;font-family:${FONT};font-size:14px;font-weight:bold;color:${RED};">PR</td>
        </tr></table>
      </td>
      <td style="padding-left:13px;font-family:${FONT};">
        <div style="font-size:19px;font-weight:bold;color:#ffffff;line-height:1.1;letter-spacing:-.3px;">PR Radar</div>
        <div style="font-size:10px;color:#ffd0d0;letter-spacing:1.5px;padding-top:4px;">BRAND &amp; REPUTATION &nbsp;·&nbsp; VODAFONE EGYPT</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:26px 26px 4px;font-family:${FONT};">
    <div style="font-size:19px;font-weight:bold;color:${INK};">${first ? `Hi ${esc(first)},` : 'Hi,'}</div>
    <div style="font-size:14.5px;line-height:1.6;color:${INK_SOFT};padding-top:10px;">
      You now have your own account on PR Radar — the daily brand &amp; reputation
      board for Vodafone Egypt. Every story the radar screens lands there sorted
      by what needs a response, with the tone, the Impact and a suggested angle
      already worked out.
    </div>
  </td></tr>

  <tr><td style="padding:18px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:${PAPER_2};border:1px solid ${HAIRLINE};border-radius:11px;">
      <tr><td style="padding:14px 18px 16px;">
        <div style="font-family:${FONT};font-size:10.5px;font-weight:bold;color:${OXBLOOD};
                    letter-spacing:.12em;text-transform:uppercase;">Your sign-in</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${row('Email', email)}
          ${row('Password', password)}
        </table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td align="center" style="padding:20px 26px 6px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td align="center" bgcolor="${RED}" style="background:${RED};border-radius:10px;">
        <a href="${esc(origin)}/login"
           style="display:block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Sign in &rarr;</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td align="center" style="padding:0 26px 18px;font-family:${FONT};font-size:12px;color:${MUTED};">
    ${isAdmin
      ? 'You land on the board with the admin tools as well — subscribers, health and the diagnostics.'
      : 'You land on the board: today&rsquo;s coverage, the trends view and the reports.'}
  </td></tr>

  <tr><td style="padding:0 26px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border-top:1px solid ${HAIRLINE};"><tr><td style="padding-top:16px;">
      <div style="font-family:${FONT};font-size:10.5px;font-weight:bold;color:${OXBLOOD};
                  letter-spacing:.12em;text-transform:uppercase;padding-bottom:9px;">Please do this first</div>
      <div style="font-family:${FONT};font-size:14px;line-height:1.6;color:${INK_SOFT};">
        <b>Change that password.</b> It was generated at random and is meant to
        get you in once — it is not something to keep. Open <b>Account &rarr; Change
        password</b> in the top bar of the board. It takes a few seconds and you only do it once.
      </div>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:18px 26px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border-top:1px solid ${HAIRLINE};"><tr><td style="padding-top:16px;">
      <div style="font-family:${FONT};font-size:10.5px;font-weight:bold;color:${OXBLOOD};
                  letter-spacing:.12em;text-transform:uppercase;padding-bottom:9px;">Worth knowing</div>
      <div style="font-family:${FONT};font-size:13.5px;line-height:1.7;color:${INK_SOFT};">
        ${subscribed
          ? bullet('The <b>daily brief</b> reaches you by email each morning — the same stories as the board, in the same three lanes.')
            + bullet('Anything urgent (Impact 4-5, or any negative story about Vodafone, Orange, WE or e&amp;) is emailed the moment it lands, so you never have to sit watching the board.')
          : bullet('You are <b>not</b> on the daily brief mailing list — the board is yours to open whenever you like. Ask to be added if you would rather have it in your inbox each morning.')}
        ${bullet(`New to it? The <a href="${esc(origin)}/guide" style="color:${RED};text-decoration:none;font-weight:bold;">guide</a> explains the lanes, what Impact means and what to do with a card.`)}
        ${bullet('On your phone: sign in once in your normal browser, then use <b>Add to Home Screen</b> and it opens like an app.')}
      </div>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:20px 26px 24px;">
    <div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED_2};border-top:1px solid ${HAIRLINE};padding-top:14px;">
      ${helpTo
        ? `Anything not working, email <a href="mailto:${esc(helpTo)}" style="color:${RED};text-decoration:none;font-weight:bold;">${esc(helpTo)}</a>.<br>`
        : ''}
      Built for the PR &amp; Communications team · Vodafone Egypt.
    </div>
  </td></tr>

</table>
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
  // Fail LOUDLY, never silently: an empty recipient list (RADAR_TO unset and no
  // explicit `to`) once made the daily brief a silent no-op for days — 200 OK,
  // no error, no email. Callers catch+log this, so the gap shows up in logs.
  if (!recipients.length) throw new Error('no recipients — RADAR_TO is unset/empty and no explicit "to" was passed');
  // `opts.forceBcc` skips BCC_EXCLUDE. That list exists to stop the STANDING
  // monitor copy someone asked to be taken off; applying it to a copy requested
  // at the moment of sending (the admin's record of a welcome email they just
  // triggered) would silently drop a BCC that was deliberately asked for.
  // Standing lists (RADAR_BCC) must never set it; one-off sends may.
  const bcc = parseAddrs(opts.bcc).filter((a) => opts.forceBcc || !BCC_EXCLUDE.has(emailOf(a)));

  // ONE MESSAGE PER RECIPIENT — never one message addressed to all of them.
  // A single call with N addresses puts every one of them in the To header, so
  // each reader sees the whole distribution list; on a corporate list that is a
  // disclosure, not a formatting detail. It also couples them: Resend rejects
  // the whole call over one malformed or suppressed address, so a single bad
  // entry silences the alert for everybody. Fanned out, a failure is contained
  // to its own recipient and the rest still land.
  // bcc rides every message, which is what the daily brief already produced —
  // it loops per recipient and passes RADAR_BCC on each call.
  const sent = [];
  const failed = [];
  for (const r of recipients) {
    const body = { from: process.env.RADAR_FROM, to: [r], subject, html };
    if (bcc.length) body.bcc = bcc;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
      sent.push(await res.json());
    } catch (e) {
      failed.push(`${emailOf(r)}: ${e.message}`);
      console.error('send failed for', emailOf(r), '—', e.message);
    }
  }
  // Reaching NOBODY still throws: callers catch, log and scream on that, and
  // that path is what makes a dead channel visible. A partial failure is
  // reported rather than thrown — the copies that landed did land.
  if (!sent.length) throw new Error(`send failed for all ${recipients.length} recipient(s): ${failed.join('; ')}`);
  // Spread the first response so callers reading `.id` keep working.
  return { ...sent[0], sent: sent.length, failed: failed.length, ids: sent.map((r) => r && r.id).filter(Boolean) };
}

/* ============================================================
   Ops alert — a pipeline problem, addressed to whoever runs it
   ============================================================ */

/** Email the operator that a health check is failing, and keep a record.
 *
 *  Persisted FIRST and independently of the send, so Admin → Health has the
 *  history even when the email itself is misconfigured or fails — and so the
 *  admin can review what happened days later instead of hunting an inbox.
 *  recordAlert is fail-soft internally (no pr_alerts table yet → false, never
 *  throws), so the log being off never blocks the mail.
 *
 *  Deliberately NOT `sendBulletin`: that one throws on an empty recipient list
 *  because a silent daily brief is a serious fault. An ops alert with nowhere
 *  to go is a misconfiguration to report, not an exception to raise inside a
 *  health check — so this returns false and lets the caller say so.
 *
 *  Recipients: `opts.to` when the caller knows who should get this one, else
 *  OPS_ALERT_TO, else RADAR_TO (the team brief list). Active subscribers are
 *  deliberately NOT used — an ops alert is for whoever runs the radar, not for
 *  its readers. `opts.to` exists because BOTH env vars are unset in production:
 *  a caller that can name a real admin (the password-reset request naming
 *  ADMIN_EMAILS) should reach them rather than record an alert and go nowhere. */
export async function sendOpsAlert(subject, lines = [], opts = {}) {
  const body = (Array.isArray(lines) ? lines : [String(lines)]).filter(Boolean);
  await recordAlert({
    kind: opts.kind || 'ops',
    severity: opts.severity || 'warn',
    title: subject,
    detail: body.join('\n'),
  });
  try {
    const to = opts.to ? parseAddrs(opts.to) : opsAlertRecipients();
    if (!to.length || !process.env.RADAR_FROM || !process.env.RESEND_API_KEY) return false;
    const when = new Date().toISOString();
    const html = `<div style="font-family:${FONT};max-width:560px;margin:0 auto;">
      <div style="background:${RED_DEEP};color:#ffffff;padding:14px 18px;border-radius:12px 12px 0 0;font-weight:bold;font-size:15px;">&#9888; PR Radar &mdash; pipeline health</div>
      <div style="background:${CARD};border:1px solid ${HAIRLINE};border-top:0;border-radius:0 0 12px 12px;padding:16px 18px;color:${INK};font-size:14px;line-height:1.6;">
        ${body.map((l) => `<div style="padding:2px 0;">${esc(l)}</div>`).join('')}
        <div style="margin-top:12px;font-size:11px;color:${MUTED_2};">${esc(when)} &middot; Admin &rarr; Health</div>
      </div></div>`;
    const text = `PR Radar — pipeline health\n\n${body.join('\n')}\n\n${when} · Admin → Health`;
    // One message per operator, same reason as sendBulletin: nobody should be
    // shown the rest of the list, and one bad address must not silence the
    // alert for everyone else. True if it reached at least one of them.
    let ok = false;
    for (const r of to) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.RADAR_FROM, to: [r], subject: String(subject).slice(0, 180), html, text }),
      });
      if (res.ok) ok = true;
      else console.error('ops alert resend', emailOf(r), res.status, (await res.text()).slice(0, 160));
    }
    return ok;
  } catch (e) {
    console.error('ops alert send failed', e && e.message);
    return false;
  }
}

/** Who a SCHEDULED ops alert reaches — the daily health push, which passes no
 *  `opts.to`. ONE expression, shared by the sender above and the check below,
 *  because two copies of a fallback chain is how a check comes to reassure you
 *  about a channel the sender no longer uses.
 *
 *  Deliberately NOT `ADMIN_EMAILS`: that is reachable only through `opts.to`,
 *  which one caller (the forgot-password request) passes explicitly. So resets
 *  can still reach a human when this list is empty — which is exactly why "my
 *  reset email arrived, so alerting works" is the wrong inference. */
export function opsAlertRecipients() {
  return parseAddrs(process.env.OPS_ALERT_TO || process.env.RADAR_TO);
}

/** Can the daily health push actually REACH anyone?
 *
 *  Every other check on Admin → Health reports on the pipeline. This one
 *  reports on the thing that DELIVERS those reports, and nothing did — the
 *  `recipients` check counts the daily BRIEF's audience (RADAR_TO + subscribers)
 *  and says nothing about the ops channel.
 *
 *  The gap mattered because the failure is silent by construction:
 *  `sendOpsAlert` calls `recordAlert()` BEFORE it attempts delivery, so with no
 *  recipients every warning was still written to `pr_alerts` and still shown in
 *  the 14-day history — while reaching no inbox. The channel never looked
 *  broken; it looked quiet. Live until 7 Aug, when OPS_ALERT_TO was first set.
 *
 *  CRIT, matching the brief's `recipients` check, which grades "nobody would
 *  receive it" the same way. It is the honest grade: the push only fires on
 *  warn/crit, so a dead channel costs nothing until something else goes wrong —
 *  and then it costs everything, silently. It cannot cry wolf either, because
 *  all three conditions are plain configuration: in a configured deployment it
 *  is green and stays green. */
export function opsChannelCheck() {
  const to = opsAlertRecipients();
  const missing = [
    !process.env.RESEND_API_KEY && 'RESEND_API_KEY',
    !process.env.RADAR_FROM && 'RADAR_FROM',
  ].filter(Boolean);

  // Same three conditions, same order, as the guard inside sendOpsAlert.
  if (missing.length) {
    return { id: 'opschannel', label: 'Alert channel', state: 'crit',
      detail: `no email can be sent — ${missing.join(' and ')} unset`,
      hint: 'Every warn/crit on this page is recorded to pr_alerts and delivered nowhere. The daily brief goes through the same provider, so this affects it too.' };
  }
  if (!to.length) {
    return { id: 'opschannel', label: 'Alert channel', state: 'crit',
      detail: 'the daily health push reaches nobody — OPS_ALERT_TO and RADAR_TO are both unset',
      hint: 'Set OPS_ALERT_TO in Vercel (a dashboard edit AND a redeploy). Until then every warning here is written to pr_alerts and shown in the history, but no email leaves — which reads as a quiet week, not a broken channel. Note a forgot-password request still reaches ADMIN_EMAILS, so a reset arriving is NOT evidence this works.' };
  }
  // The COUNT, not the addresses: this payload is admin-only, but an operator
  // list is not something a health page needs to spell out to answer "is it
  // configured" — the same call the WhatsApp check makes by masking numbers.
  const via = process.env.OPS_ALERT_TO ? 'OPS_ALERT_TO' : 'RADAR_TO';
  return { id: 'opschannel', label: 'Alert channel', state: 'ok',
    detail: `${to.length} operator${to.length === 1 ? '' : 's'} via ${via}`,
    hint: via === 'RADAR_TO'
      ? 'OPS_ALERT_TO is unset, so ops alerts fall back to the team brief list — the people who read the news, not the person who runs the radar.'
      : '' };
}
