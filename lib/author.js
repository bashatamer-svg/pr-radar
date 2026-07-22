// Author extraction for the PR Radar. "Who published it" is a hard requirement
// here, so this is deliberately a cascade of the most reliable signals first.
//
// TWO SOURCES OF AUTHOR, in priority order:
//   1. RSS byline — many feeds (esp. WordPress: Daily News Egypt, Technotime,
//      Amwal Al Ghad) carry <dc:creator> or <author> in the feed itself. That
//      is free and instant; authorFromEntry() below pulls it during parsing.
//   2. Article-page fetch — for items with no RSS byline (Google News items,
//      mostly), fetchAuthor() retrieves the article HTML and extracts the
//      author from JSON-LD, then <meta>, then a visible byline.
//
// HONEST LIMITS (do not paper over these):
//   - Some articles have NO byline at all (wire copy, "staff", agency reposts).
//     Nothing can invent an author that the publisher didn't attach.
//   - Some sites block server-side fetches (403 / Cloudflare) or are paywalled.
//   - Google News URLs are redirect *wrappers* (news.google.com/rss/articles/…)
//     that don't HTTP-redirect to the article — they must be decoded to the real
//     URL FIRST (the app's existing /api/go resolver). Pass fetchAuthor() a
//     resolved publisher URL, not a raw Google News token, or it will read
//     Google's own page and find nothing.
//
// The function never throws — on any failure it returns null, and the caller
// stores author as null (shown as "—" on the board). A missing author is
// visible and honest, never fabricated.

const TIMEOUT_MS = 6000;

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
};

// Reject obvious non-person values so we don't store junk as an author.
const BAD = new Set([
  '', 'admin', 'administrator', 'staff', 'editor', 'editorial', 'newsroom',
  'correspondent', 'reporter', 'agencies', 'agency', 'staff writer',
  'staff report', 'staff reporter', 'web desk', 'news desk', 'guest',
  // Arabic generic / desk bylines (not a person)
  'تحرير', 'المحرر', 'محرر', 'فريق التحرير', 'هيئة التحرير', 'وكالات', 'خاص', 'متابعة',
]);

function cleanName(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/<[^>]+>/g, ' ')          // strip any stray tags
    .replace(/\s+/g, ' ')
    .replace(/^\s*(by|بقلم|كتب|كتبت)\s*[:\-–]?\s*/i, '') // drop "By " / Arabic "بقلم"
    .trim();
  // Some feeds pack an email or handle in; take the human part.
  s = s.replace(/\s*<[^>]*@[^>]*>\s*/g, '').trim();
  if (!s || BAD.has(s.toLowerCase())) return null;
  if (s.length > 80) return null;       // a paragraph, not a byline
  return s;
}

// True when the supposed "author" is really the outlet / publication itself —
// many feeds drop the site name into <dc:creator> (e.g. "Techno Time",
// "Fintechgate"). We never render a brand as if it were a person, so the caller
// nulls these and the board shows an honest "—". Two signals: the name carries a
// publication marker (portal / agency / "gate"), or it matches the outlet name.
export function isOutletName(name, outlet) {
  if (!name) return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '');
  const a = norm(name);
  if (!a) return false;
  // Publication / agency marker anywhere in the string.
  if (/(gate|newsroom|بوابة|وكالة|موقع|شبكة|جريدة|صحيفة)/i.test(name)) return true;
  // A desk word as one of the separated parts — the common Arabic wire byline
  // shape "<outlet> - خاص" / "<outlet> - متابعة" ("Al-Mal - Exclusive"), which is
  // the publication, not a person.
  for (const part of String(name).split(/[-–—·|/،,]+/)) {
    if (BAD.has(part.trim().toLowerCase())) return true;
  }
  // The "name" is really just the outlet.
  const o = norm(outlet);
  if (o && o.length >= 3 && (a === o || a.includes(o) || o.includes(a))) return true;
  return false;
}

// Turn a raw byline into a displayable PERSON, or null. Wraps cleanName +
// isOutletName, with one improvement over calling them directly: a compound
// desk byline like "محمد علي - خاص" or "Al-Mal - John Smith" used to be
// rejected WHOLESALE because one part is a desk word — throwing away the real
// person. Here we split on the separators, drop the desk/outlet parts, and keep
// the person if exactly one part survives. A pure "<outlet> - خاص" still
// (correctly) returns null.
export function cleanAuthor(raw, outlet) {
  const c = cleanName(raw);
  if (!c) return null;
  if (!isOutletName(c, outlet)) return c;
  const parts = String(c).split(/[-–—·|/،,]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const person = parts.filter(
    (p) => !BAD.has(p.toLowerCase()) && !isOutletName(p, outlet)
  );
  if (person.length === 1) {
    const keep = cleanName(person[0]);
    if (keep && keep.length >= 3) return keep;
  }
  return null;
}

// ---- 1. RSS-level author (free, no fetch) --------------------------------
// Call with a parsed feed entry (fast-xml-parser object). Handles the common
// shapes: <dc:creator>, <author><name>…</name></author> (Atom), <author>Name…
export function authorFromEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const cand =
    e['dc:creator'] ??
    e.creator ??
    (e.author && typeof e.author === 'object'
      ? (e.author.name ?? e.author['#text'])
      : e.author) ??
    null;
  const val = cand && typeof cand === 'object' ? (cand['#text'] ?? '') : cand;
  return cleanName(val);
}

// ---- 2. Article-page author (fetch + parse) ------------------------------
function fromJsonLd(html) {
  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return null;
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    let data;
    try { data = JSON.parse(json); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const a = node.author;
      if (!a) continue;
      const first = Array.isArray(a) ? a[0] : a;
      const name = first && typeof first === 'object' ? first.name : first;
      const cleaned = cleanName(name);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function fromMeta(html) {
  // Ordered by reliability. Attribute ORDER varies by CMS — both
  // <meta name="author" content="…"> and <meta content="…" name="author"> are
  // common in the wild — so match the whole tag by its name/property first,
  // then pull content= out of it regardless of position. article:author is
  // sometimes a URL, not a name — the URL guard + cleanName reject those.
  const keys = ['author', 'article:author', 'sailthru\\.author', 'parsely-author'];
  for (const key of keys) {
    const tag = html.match(
      new RegExp(`<meta\\s[^>]*(?:name|property)=["']${key}["'][^>]*>`, 'i')
    );
    if (!tag) continue;
    const m = tag[0].match(/content=["']([^"']+)["']/i);
    if (m && !/^https?:\/\//i.test(m[1])) {
      const c = cleanName(m[1]);
      if (c) return c;
    }
  }
  return null;
}

// Name-shaped: 2–5 words of letters (any script), no digits or sentence
// punctuation. Guards the riskier byline patterns below against capturing a
// sentence fragment instead of a person.
function looksLikeName(s) {
  const t = String(s || '').trim();
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (!/^[\p{L}][\p{L} .'’-]+$/u.test(t)) return false;
  // Arabic function words / article nouns never appear inside a personal name —
  // "كتب المقال عن الاقتصاد" must not pass as "author: المقال عن الاقتصاد".
  // (على the preposition differs from علي the name — ى vs ي — so it's safe.)
  const STOP = new Set(['عن', 'في', 'على', 'من', 'إلى', 'الى', 'أن', 'ان',
    'هذا', 'هذه', 'المقال', 'الخبر', 'التقرير', 'الموضوع']);
  return !words.some((w) => STOP.has(w));
}

function fromByline(html) {
  // Last resort: a visible byline. Common WordPress pattern is a link to an
  // /author/<slug>/ page (this is exactly what Daily News Egypt renders).
  const m =
    html.match(/<a[^>]+href=["'][^"']*\/author\/[^"']*["'][^>]*>([^<]{2,60})<\/a>/i) ||
    html.match(/rel=["']author["'][^>]*>([^<]{2,60})</i) ||
    html.match(/class=["'][^"']*\bbyline\b[^"']*["'][^>]*>\s*(?:by\s+)?([^<]{2,60})</i) ||
    html.match(/(?:بقلم|كتبت?|حرره)\s*[:\-–]\s*([^<\n،.]{3,40})/);
  if (m) return cleanName(m[1]);
  // Arabic byline with NO separator — "كتب محمد أحمد" — is very common on
  // Egyptian sites. Riskier (كتب is also the noun "books"), so only accept a
  // capture that is name-shaped.
  const m2 = html.match(/(?:بقلم|كتبت|كتب)\s+([؀-ۿ][؀-ۿ .]{4,40})/);
  if (m2 && looksLikeName(m2[1])) return cleanName(m2[1]);
  return null;
}

export function extractAuthorFromHtml(html) {
  if (!html) return null;
  return fromJsonLd(html) || fromMeta(html) || fromByline(html) || null;
}

// Fetch a RESOLVED publisher URL and extract the author. Returns null on any
// failure (timeout, 403, no byline). Never throws.
export async function fetchAuthor(url) {
  if (!url || /(^|\.)news\.google\.com/i.test(url)) return null; // must be resolved first
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: BROWSER_HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    return extractAuthorFromHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
