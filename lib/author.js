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

import { isNonArticlePage } from './resolve.js';
import { recordUsage } from './usage.js';

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

// Site-furniture words that never occur inside a real person's name — search
// placeholders, nav labels, footer links. A scraped template string like
// "كلمة البحث هنا" ("search word here", Sada El-Balad's search box) must never
// become a byline. Only UNAMBIGUOUS words are listed: e.g. هنا ("here") is
// excluded because it is also a real given name (هنا الزاهد), but بحث/كلمة
// never are; English sticks to pure UI terms (no "Read"/"Home" — real surnames).
const UI_JUNK =
  /(?:^|\s)(?:بحث|البحث|ابحث|كلمة|اشترك|اشتراك|تسجيل|الدخول|القائمة|الرئيسية|المرور|تابعنا|تابعونا|المزيد|التطبيق|أرشيف|الأرشيف|الارشيف|إعلان|اعلان)(?:\s|$)|\b(?:search|login|log ?in|sign ?up|register|subscribe|menu|password|keywords?|homepage|sidebar|widget|click)\b/i;

function cleanName(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/<[^>]+>/g, ' ')          // strip any stray tags
    .replace(/\s+/g, ' ')
    .replace(/^\s*(by|بقلم|كتب|كتبت)\s*[:\-–]?\s*/i, '') // drop "By " / Arabic "بقلم"
    .trim();
  // Some feeds pack an email or handle in; take the human part.
  s = s.replace(/\s*<[^>]*@[^>]*>\s*/g, '').trim();
  // A bare email address is a CMS ACCOUNT, not a byline (author metas often
  // carry the site admin's gmail) — and no real person's name contains @.
  if (s.includes('@')) return null;
  if (!s || BAD.has(s.toLowerCase())) return null;
  if (UI_JUNK.test(s)) return null;     // page furniture, not a person
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
// Each source returns ALL its raw candidates (no early validation) — see
// extractAuthorFromHtml for why.
function jsonLdCandidates(html) {
  const out = [];
  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return out;
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    let data;
    try { data = JSON.parse(json); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const a = node.author;
      if (!a) continue;
      for (const entry of (Array.isArray(a) ? a : [a])) {
        const name = entry && typeof entry === 'object' ? entry.name : entry;
        if (name) out.push(name);
      }
    }
  }
  return out;
}

function metaCandidates(html) {
  // Ordered by reliability. Attribute ORDER varies by CMS — both
  // <meta name="author" content="…"> and <meta content="…" name="author"> are
  // common in the wild — so match the whole tag by its name/property first,
  // then pull content= out of it regardless of position. article:author is
  // sometimes a URL, not a name — skip those outright.
  const out = [];
  const keys = ['author', 'article:author', 'sailthru\\.author', 'parsely-author'];
  for (const key of keys) {
    const tag = html.match(
      new RegExp(`<meta\\s[^>]*(?:name|property)=["']${key}["'][^>]*>`, 'i')
    );
    if (!tag) continue;
    const m = tag[0].match(/content=["']([^"']+)["']/i);
    if (m && !/^https?:\/\//i.test(m[1])) out.push(m[1]);
  }
  return out;
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

/* ── the SUBJECT of the story is not its author ────────────────────────────
   Live, 6 Aug: an Ahram Online interview — "INTERVIEW| Egypt mobile wallet
   market triples since COVID, Axis Pay targets 3 mln users: Axis CEO" — was
   filed with the byline "Jacques Marco", who is the Axis Pay CEO being
   INTERVIEWED. The card credited the subject of the story as its journalist,
   which is worse than showing no byline: it puts words in a named person's
   mouth on a board the PR team reads as fact.
   The AI prompt already said "never a person merely mentioned or quoted in the
   story (an official, a CEO)" — and it was not enough, which is the pattern
   this codebase keeps meeting: a judgement the model gets wrong needs a
   deterministic guard beside the instruction, not a firmer instruction.
   Two signals, both cheap and language-agnostic:
     * the name sits next to a ROLE ("Jacques Marco, CEO of Axis Pay")
     * the name is introduced by a QUOTE verb ("said Jacques Marco")
   An explicit byline marker immediately before the name WINS over both, so a
   real byline that happens to sit near a quote is untouched. */
const SUBJECT_ROLE = new RegExp([
  'chief (?:executive|financial|operating|technology|marketing|commercial)',
  '\\bC(?:E|F|O|T|M)O\\b', 'chair(?:man|woman|person)', 'co-?founder', 'founder',
  'managing director', 'general manager', 'vice[- ]president', 'president',
  'minister', 'governor', 'spokes(?:man|woman|person)', 'head of', 'director of',
  'board member', 'ambassador', 'deputy',
  // Arabic
  'الرئيس التنفيذي', 'المدير التنفيذي', 'المدير العام', 'العضو المنتدب',
  'رئيس مجلس', 'نائب رئيس', 'مؤسس', 'وزير', 'محافظ', 'المتحدث', 'عضو مجلس',
].join('|'), 'i');
const QUOTE_VERB = new RegExp([
  '\\bsaid\\b', '\\bsays\\b', '\\btold\\b', '\\badded\\b', '\\bexplained\\b',
  '\\bnoted\\b', '\\bstated\\b', 'according to', '\\btold\\b',
  'قال', 'قالت', 'أضاف', 'أوضح', 'صرح', 'صرّح', 'أكد', 'وأشار',
].join('|'), 'i');
// "By X" / "بقلم X" / "كتب: X" directly before the name — an explicit credit.
const BYLINE_BEFORE = /(?:\bby\b|written by|بقلم|كتبت?|حرره)\s*[:\-–—]?\s*$/i;

// A publication DATE immediately after a name is the strongest unlabelled byline
// signal there is — newspapers print "<journalist> , <date>" and nothing else on
// the page carries that shape. Ahram Online renders exactly this, with no "By"
// and no byline class, which is how a real journalist was missed while the CEO
// quoted in the first paragraph was stored instead (user-reported, 6 Aug).
const DATE_TOKEN = [
  '(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?',
  '\\d{1,2}\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*',
  '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\s*\\d{1,2}',
  '\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}',
  'الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت',
  '\\d{1,2}\\s*(?:يناير|فبراير|مارس|أبريل|إبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)',
].join('|');
const DATELINE_AFTER = new RegExp(`^\\s*[,،|·•\\-–—]?\\s*(?:${DATE_TOKEN})\\b`, 'i');

/** Does `name` read as someone the story is ABOUT rather than the person who
    wrote it? Scans the same reading window the extractor uses. */
export function isStorySubject(name, text) {
  const n = String(name || '').trim();
  const src = String(text || '');
  if (n.length < 3 || !src) return false;
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m, seen = 0, flagged = 0;
  while ((m = re.exec(src)) !== null && seen < 8) {
    seen++;
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    const after = src.slice(m.index + n.length, m.index + n.length + 60);
    // Credited outright somewhere on the page → it IS the byline, whatever else
    // surrounds the other mentions.
    if (BYLINE_BEFORE.test(before)) return false;
    // POSITIVE EVIDENCE WINS. Without this the guard ate the real byline on the
    // very page that prompted it: Ahram's flattened text reads
    // "…targets 3 mln users: Axis CEO Doaa A.Moneim , Thursday 6 Aug 2026", so
    // the headline's own "CEO" sits nine characters before the journalist's name.
    if (DATELINE_AFTER.test(after)) return false;
    // A ROLE has to be CLOSE — "X, CEO of Y", "قال الرئيس التنفيذي X". Widen
    // this and an unlabelled byline sitting above a paragraph about a minister
    // gets thrown away with the interviewees.
    if (SUBJECT_ROLE.test(`${before.slice(-30)} ${after.slice(0, 30)}`)) { flagged++; continue; }
    // Quote verbs must be IMMEDIATELY adjacent — "said X" / "X said". Anything
    // looser fails on the commonest shape in news copy: a bare byline directly
    // above a first sentence that happens to contain "said"
    // ("Fintech Gate: Riham Ali" / "Vodafone Egypt said …"), which this test
    // caught rejecting a real journalist.
    if (/^[\s,،:;.—–-]{0,3}(?:said|says|told|added|explained|noted|stated|قال|قالت|أضاف|أوضح|صرح|صرّح|أكد)\b/i.test(after)
      || /\b(?:said|says|told|added|explained|noted|stated|according to|قال|قالت|أضاف|أوضح|صرح|صرّح|أكد|وأشار)[\s,،:;—–-]{0,3}$/i.test(before)) flagged++;
  }
  return flagged > 0;
}

/** A journalist's name is not in the headline; an interviewee's often is
    ("…: Axis CEO Jacques Marco"). Cheap, and with no false positives worth
    the byline it would cost. */
export function isNamedInHeadline(name, headline) {
  const n = String(name || '').trim().toLowerCase();
  const h = String(headline || '').toLowerCase();
  return n.length >= 3 && h.length > 0 && h.includes(n);
}

/** "<name> , <date>" read from the article TEXT — the markup between the two
    varies (a link, a span, bare text), so this reads the flattened opening
    instead of guessing at tags. Bounded to the first 1500 chars, where a byline
    lives; deeper in the body "…on Tuesday" would start matching sentences. */
function datelineCandidates(text) {
  const src = String(text || '').slice(0, 1500);
  const out = [];
  // Find the DATE first (case-insensitively), then walk BACK over the tokens
  // before it. Doing this as one regex needs the `i` flag for the month names —
  // and under `i`, \p{Lu} matches lowercase too, so the name capture swallowed
  // whole clauses of the headline ("its network Mona Said"). Two steps instead.
  const dateRe = new RegExp(DATE_TOKEN, 'gi');
  let m;
  while ((m = dateRe.exec(src)) !== null && out.length < 4) {
    const before = src.slice(Math.max(0, m.index - 70), m.index);
    // The separator between a byline and its dateline is always there; without
    // requiring it, any two capitalised words before "…on Tuesday" would credit
    // someone who merely appears in the sentence.
    const sep = before.match(/[,،|·•]\s*$/);
    if (!sep) continue;
    const toks = before.slice(0, before.length - sep[0].length).trim().split(/\s+/);
    const run = [];
    for (let i = toks.length - 1; i >= 0 && run.length < 4; i--) {
      const t = toks[i];
      // Stop at an ALL-CAPS token or a job title: the flattened Ahram text is
      // "…3 mln users: Axis CEO Doaa A.Moneim , Thursday 6 Aug 2026", so without
      // this the run walks out of the byline and into the headline's "Axis CEO".
      if (/^[A-Z]{2,}$/.test(t) || SUBJECT_ROLE.test(t)) break;
      if (!/^[\p{Lu}\p{Script=Arabic}][\p{L}.'’-]*$/u.test(t)) break;
      run.unshift(t);
    }
    if (run.length >= 2) out.push(run.join(' '));
  }
  return out;
}

function bylineCandidates(html) {
  // Visible bylines. Common WordPress pattern is a link to an /author/<slug>/
  // page (this is exactly what Daily News Egypt renders).
  const out = [];
  const patterns = [
    /<a[^>]+href=["'][^"']*\/author\/[^"']*["'][^>]*>([^<]{2,60})<\/a>/i,
    // …and as a QUERY parameter: Ahram Online links its journalists as
    // /Search.aspx?author=… , which the path-segment pattern above misses.
    /<a[^>]+href=["'][^"']*[?&]author=[^"']*["'][^>]*>([^<]{2,60})<\/a>/i,
    /rel=["']author["'][^>]*>([^<]{2,60})</i,
    /class=["'][^"']*\bbyline\b[^"']*["'][^>]*>\s*(?:by\s+)?([^<]{2,60})</i,
    /(?:بقلم|كتبت?|حرره)\s*[:\-–]\s*([^<\n،.]{3,40})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) out.push(m[1]);
  }
  // Arabic byline with NO separator — "كتب محمد أحمد" — is very common on
  // Egyptian sites. Riskier (كتب is also the noun "books"), so only accept a
  // capture that is name-shaped.
  const m2 = html.match(/(?:بقلم|كتبت|كتب)\s+([؀-ۿ][؀-ۿ .]{4,40})/);
  if (m2 && looksLikeName(m2[1])) out.push(m2[1]);
  return out;
}

// FIRST VALID WINS — not first non-empty. The old cascade stopped at the first
// source that yielded anything, so junk in a high-priority source (a CMS email
// or the outlet's own name in the author meta, a search-box placeholder in
// JSON-LD) masked a REAL byline printed lower on the page (ekhbary24: meta
// carried the admin's gmail while the article said "كتب: أحمد عبد السلام").
// Now every source contributes its candidates in priority order and each is
// put through the FULL person validation (cleanAuthor: email/UI-junk/desk
// rejection, outlet-name check, person shape) — the first survivor is the
// author, regardless of which source it came from. `outlet` sharpens the
// outlet-name check when the caller knows it; generic publication markers
// (بوابة/وكالة/gate/portal…) apply either way.
export function extractAuthorFromHtml(html, outlet = null, { headline = null } = {}) {
  if (!html) return null;
  // The page's own reading window — both the dateline source and the subject
  // check read it, so the extractor and its guard see the same text.
  const text = htmlToText(html);
  const candidates = [
    ...jsonLdCandidates(html), ...metaCandidates(html), ...bylineCandidates(html),
    // Last, so anything the page DECLARES still wins: an unlabelled name
    // followed by the publication date.
    ...datelineCandidates(text),
  ];
  for (const c of candidates) {
    const person = cleanAuthor(c, outlet);
    if (!person) continue;
    // A person the story is ABOUT is not its author, whichever source offered
    // the name — an interviewee reaches JSON-LD and metas too.
    if (isNamedInHeadline(person, headline)) continue;
    if (isStorySubject(person, text)) continue;
    return person;
  }
  return null;
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
  let src = String(html || '');
  // Read the ARTICLE the way a person's eyes do — jump straight to the story,
  // skip the site chrome. On real news pages thousands of characters of nav
  // menus / trending links precede the body, so a top-of-page slice can spend
  // the whole reading window before ever reaching the headline + byline. Cut
  // from the article container (or the first <h1>) when one exists.
  const cut = (() => {
    const a = src.search(/<(?:article|main)[\s>]/i);
    if (a >= 0) return a;
    return src.search(/<h1[\s>]/i);
  })();
  if (cut > 0) src = src.slice(cut);
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500); // the byline lives near the headline; 3.5k chars is plenty
}

let aiCalls = 0;

// The AI cap is a PER-RUN budget, not per-process: Vercel keeps the lambda
// warm between invocations, so a counter that only ever increments silently
// exhausted itself — a second "Backfill authors" click in the same warm
// process ran with ZERO AI reads and reproduced identical no-byline verdicts.
// Callers (radar handler, backfill sweep) reset at the start of each run.
export function resetAuthorAiBudget() { aiCalls = 0; }

async function aiExtractAuthor(text, headline = null) {
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
          'Rules: the author is a HUMAN PERSON credited for THIS article ' +
          '(e.g. "By X", "كتب: X", "بقلم X", "<Outlet>: X", a name directly under the headline). ' +
          'A name followed by the PUBLICATION DATE is the byline — "Doaa A.Moneim , Thursday 6 Aug 2026" ' +
          'means Doaa A.Moneim wrote it. Return the name, never the date. ' +
          'Egyptian sites often print the byline as a bare UNLABELLED person name right beside the ' +
          'headline or just before the breadcrumb (e.g. "محمد شبل الرئيسية / اتصالات") — that IS the ' +
          'byline; return it (strip honorifics like المهندس/الأستاذ). ' +
          'PHOTO credits are NOT the author: ignore names right after تصوير / عدسة / صورة / أرشيفية. ' +
          'NEVER return a publication, agency, desk ("staff", "وكالات", "خاص"), or a person merely ' +
          'mentioned or quoted IN the story (an official, a CEO). ' +
          // The failure this rule was written for kept happening, so it now names
          // the shape: an INTERVIEW opens on the interviewee, whose name sits
          // where a byline would and is followed by their job title.
          'INTERVIEWS are the trap: the person being interviewed is the SUBJECT, never the author, ' +
          'even when their name is the first one on the page. A name followed or preceded by a JOB ' +
          'TITLE ("X, CEO of Y", "الرئيس التنفيذي X") or by a quote verb ("said X", "قال X") is a ' +
          'subject — return null unless a SEPARATE name is credited for writing. ' +
          'If no byline is written, return null. Do not guess.',
        messages: [{ role: 'user', content: headline ? `HEADLINE: ${headline}\n\n${text}` : text }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    recordUsage('author', process.env.CLASSIFIER_MODEL || null, data);   // fire-and-forget spend gauge; never awaited
    const out = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
    const s = out.indexOf('{'), e = out.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    const parsed = JSON.parse(out.slice(s, e + 1));
    const name = cleanName(parsed.author);
    // The instruction above is not trusted on its own — it was already there
    // when a CEO came back as the author. Same guard as the deterministic path.
    if (!name) return null;
    if (isNamedInHeadline(name, headline) || isStorySubject(name, text)) return null;
    return name;
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

// A second legitimate browser identity: some sites gate the desktop UA but
// serve their mobile audience unconditionally. (No crawler impersonation —
// both profiles are ordinary browsers.)
const MOBILE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

// Try the URL under several legitimate browser profiles — desktop, desktop
// with a same-origin referer, mobile Safari — some sites 403 exactly one of
// these. Returns { res, tried } where `tried` logs each attempt's status, so
// the admin "Verify verdicts" evidence shows a block was TESTED three ways,
// not assumed from one response.
async function fetchArticle(url) {
  let origin = ''; try { origin = new URL(url).origin + '/'; } catch { /* keep '' */ }
  const profiles = [
    ['desktop', {}, TIMEOUT_MS],
    ['desktop+referer', origin ? { referer: origin } : {}, 4000],
    ['mobile', MOBILE_HEADERS, 4000],
  ];
  const tried = [];
  for (const [name, headers, ms] of profiles) {
    let res = null;
    try { res = await fetchHtml(url, headers, ms); } catch { res = null; }
    tried.push({ profile: name, status: res ? res.status : 'timeout' });
    if (res && res.ok) return { res, tried };
  }
  return { res: null, tried };
}

export async function fetchAuthorProbe(url, outlet = null, { headline = null } = {}) {
  if (!url || /(^|\.)news\.google\.com/i.test(url)) return { author: null, outcome: 'fetch-failed' };
  // Tag/keyword/search archive pages are navigation, not articles — whatever a
  // scrape finds there is template furniture, never this story's byline.
  if (isNonArticlePage(url)) return { author: null, outcome: 'no-byline' };
  const { res } = await fetchArticle(url);
  if (!res) return { author: null, outcome: 'fetch-failed' };
  try {
    const html = await res.text();
    const author = extractAuthorFromHtml(html, outlet, { headline })
      || await aiExtractAuthor(htmlToText(html), headline);
    return { author, outcome: author ? 'found' : 'no-byline' };
  } catch { return { author: null, outcome: 'fetch-failed' }; }
}

// Author-or-null wrapper over the probe (the common case). Never throws.
export async function fetchAuthor(url, outlet = null, opts = {}) {
  return (await fetchAuthorProbe(url, outlet, opts)).author;
}

// Deep probe backing the admin "Verify verdicts" diagnostic: the SAME fetch +
// extraction as fetchAuthorProbe, but it also returns the evidence — the
// opening article text production actually read and every raw candidate the
// page offered — so a human can confirm a no-byline verdict with their own
// eyes instead of trusting the label. Never throws.
export async function inspectAuthorPage(url, outlet = null, { headline = null } = {}) {
  const empty = { author: null, textStart: '', candidates: [], tried: [] };
  if (!url || /(^|\.)news\.google\.com/i.test(url)) return { ...empty, outcome: 'fetch-failed', status: null };
  if (isNonArticlePage(url)) return { ...empty, outcome: 'not-article', status: null };
  const { res, tried } = await fetchArticle(url);
  if (!res) {
    const last = tried[tried.length - 1];
    return { ...empty, outcome: 'fetch-failed', status: typeof last?.status === 'number' ? last.status : null, tried };
  }
  try {
    const html = await res.text();
    const candidates = [...jsonLdCandidates(html), ...metaCandidates(html), ...bylineCandidates(html)]
      .slice(0, 6).map((c) => String(c).slice(0, 60));
    const text = htmlToText(html);
    const author = extractAuthorFromHtml(html, outlet, { headline }) || await aiExtractAuthor(text, headline);
    // Which candidates were refused as the story's SUBJECT rather than its
    // author. Without this the panel reports "no byline" for a page that plainly
    // shows a name, and the reader cannot tell a working guard from a bug.
    const subjects = author ? [] : candidates
      .map((c) => cleanAuthor(c, outlet))
      .filter((n) => n && (isNamedInHeadline(n, headline) || isStorySubject(n, text)))
      .slice(0, 4);
    return { outcome: author ? 'found' : 'no-byline', status: res.status, author,
      textStart: text.slice(0, 300), candidates, ...(subjects.length ? { subjects } : {}), tried };
  } catch { return { ...empty, outcome: 'fetch-failed', status: null, tried }; }
}

// Is the AI byline fallback actually usable? (Key present AND not kill-switched.)
export function authorAiEnabled() {
  return process.env.AUTHOR_AI !== '0' && !!process.env.ANTHROPIC_API_KEY;
}
