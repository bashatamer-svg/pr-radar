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

// A fuller, real-browser header set. Several Egyptian outlets 403 a request that
// omits Accept-Language or a Referer, so we send both — it legitimately lifts
// the block rate on the sites that gate on missing headers (not the Cloudflare
// ones, which won't yield to a serverless fetch regardless).
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
  referer: 'https://www.google.com/',
  'upgrade-insecure-requests': '1',
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
  // Publication / agency marker anywhere in the string. Latin markers are
  // matched at a WORD boundary so a surname like "Gates" isn't read as the
  // outlet marker "Gate"; the Arabic markers have no such ambiguity.
  if (/\b(gate|newsroom|portal)\b/i.test(name) || /(بوابة|وكالة|موقع|شبكة|جريدة|صحيفة)/.test(name)) return true;
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

// Byline segment separators: pipe, slash, middot, bullet, ASCII + fullwidth
// colon, and ' - ' (spaces around the dash, so hyphenated names survive).
const SEP = /\s*[|/·•:：]\s*|\s+[-–—]\s+/;

// A segment that looks like a PERSON: 2–4 words, letters (any script) plus the
// punctuation real names carry, no digits. ≥2 words so a lone publication word
// ("Gate", "المال") can't pass as a name.
function looksLikePerson(s) {
  const t = String(s || '').trim();
  if (!t || /\d/.test(t) || t.length < 3 || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return /^[\p{L}][\p{L} .ّ’'\-]*$/u.test(t);
}

// Resolve a raw byline to a displayable PERSON, or null — GENERALLY, not per site.
export function cleanAuthor(raw, outlet) {
  const c = cleanName(raw);
  if (!c) return null;
  const segments = c.split(SEP).map((s) => s.trim()).filter(Boolean);
  if (segments.length <= 1) return isOutletName(c, outlet) ? null : c;
  const persons = segments.filter(
    (s) => !BAD.has(s.toLowerCase()) && !isOutletName(s, outlet) && looksLikePerson(s)
  );
  if (persons.length >= 1) return persons[0];
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

// ---- 3. AI fallback (general, format-agnostic) ---------------------------
// The deterministic cascade above knows JSON-LD, metas and the common byline
// markup — but Egyptian sites render bylines in endlessly varied shapes
// ("Finteck Gate: Riham Ali" as plain text under the headline, a bare span,
// an image caption…), and chasing each with a new regex is whack-a-mole. So
// when the cascade finds NOTHING, we ask a cheap model one narrow question
// about the article's opening text: "is there an explicit byline? name or
// null". Any format, any language, no per-site rules.
//
// Guard-rails: only fires when deterministic extraction failed; hard-capped
// per process/run (AUTHOR_AI_MAX, default 40 calls) so cost is bounded; kill
// switch AUTHOR_AI=0; instructed to NEVER guess (null unless a byline is
// explicitly written); output still passes cleanName here and cleanAuthor
// (outlet check) in the caller, so a hallucinated or outlet name is rejected.
// Never throws.

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500); // the byline lives at the top; 3.5k chars is plenty
}

let aiCalls = 0;
async function aiExtractAuthor(text) {
  if (process.env.AUTHOR_AI === '0') return null;
  if (!process.env.ANTHROPIC_API_KEY || !text || text.length < 80) return null;
  const MAX = Number(process.env.AUTHOR_AI_MAX) || 40;
  if (aiCalls >= MAX) return null;
  aiCalls++;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        system:
          'You extract the AUTHOR BYLINE from the opening text of a news article (Arabic or English). ' +
          'Return ONLY JSON: {"author": "<person name>"} or {"author": null}. ' +
          'Rules: the author is a HUMAN PERSON explicitly credited for THIS article ' +
          '(e.g. "By X", "كتب: X", "بقلم X", "<Outlet>: X", a name directly under the headline). ' +
          'NEVER return a publication, agency, desk ("staff", "وكالات", "خاص"), or a person merely ' +
          'mentioned IN the story (an official, a CEO). If no explicit byline is written, return null. ' +
          'Do not guess.',
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
    const s = out.indexOf('{'), e = out.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    const parsed = JSON.parse(out.slice(s, e + 1));
    return cleanName(parsed.author);
  } catch {
    return null;
  }
}

// Fetch a RESOLVED publisher URL and extract the author, reporting WHY it failed:
//   { author, outcome } where outcome is
//     'found'        — a byline was extracted (deterministic cascade or AI)
//     'no-byline'    — the page fetched OK (200) but carried no byline
//     'fetch-failed' — couldn't fetch it: non-OK status (403/blocked), timeout,
//                      network error, or a Google-News wrapper passed unresolved
// Backs the coverage diagnostics. Never throws.
async function fetchHtml(url, extraHeaders, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, headers: { ...BROWSER_HEADERS, ...extraHeaders }, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

export async function fetchAuthorProbe(url) {
  if (!url || /(^|\.)news\.google\.com/i.test(url)) return { author: null, outcome: 'fetch-failed' };
  let res = null;
  try { res = await fetchHtml(url, {}, TIMEOUT_MS); } catch { res = null; }
  // Some sites 403 or stall a first bot hit but serve a SAME-ORIGIN referer.
  // One cheaper retry meaningfully lifts the block rate; the Cloudflare ones
  // still won't yield, and land honestly in 'fetch-failed'.
  if (!res || !res.ok) {
    let origin = ''; try { origin = new URL(url).origin + '/'; } catch { /* keep '' */ }
    try { res = await fetchHtml(url, origin ? { referer: origin } : {}, 4000); } catch { res = null; }
  }
  if (!res || !res.ok) return { author: null, outcome: 'fetch-failed' };
  try {
    const html = await res.text();
    const author = extractAuthorFromHtml(html) || await aiExtractAuthor(htmlToText(html));
    return { author, outcome: author ? 'found' : 'no-byline' };
  } catch { return { author: null, outcome: 'fetch-failed' }; }
}

// Author-or-null wrapper over the probe (the common case). Never throws.
export async function fetchAuthor(url) {
  return (await fetchAuthorProbe(url)).author;
}

// Is the AI byline fallback actually usable? (Key present AND not kill-switched.)
export function authorAiEnabled() {
  return process.env.AUTHOR_AI !== '0' && !!process.env.ANTHROPIC_API_KEY;
}
