// Scraped MARKUP is never a byline, and neither is a URL slug.
//
// Live, user-reported (6 Aug): an Astro-built outlet filed the author of
// «تحرك عاجل لحماية المواطنين» as
//     بريد-لتسهيل-تقديم-التظلمات" data-astro-c
// — the tail of an href slug, the attribute's closing quote, and the start of
// Astro's `data-astro-cid-*`. The page's real byline is "Mohamed Hamada".
//
// TWO faults, and the second is the one that matters:
//   1. Several byline patterns capture `[^<]{2,60}` after hopping to the first
//      `>`. When an attribute VALUE contains a `>`, that hop lands inside the
//      tag, so the capture starts mid-attribute and runs into the next one.
//   2. cleanAuthor returned a SINGLE-segment candidate unchecked — the
//      person-shape test only ever ran on names that split into segments. So
//      nothing downstream objected to a blob of raw markup.
//
// Hardening each regex would be whack-a-mole; the guard is deterministic and
// sits at the bottom of the funnel, so it holds for every source (JSON-LD,
// metas, visible bylines, datelines and the AI fallback alike).
import assert from 'node:assert';
import { extractAuthorFromHtml, cleanAuthor } from '../lib/author.js';

let pass = 0;
const check = (label, actual, expected) => {
  assert.strictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  pass++; console.log(`  ✓ ${label}`);
};

const SLUG = 'بريد-لتسهيل-تقديم-التظلمات';

// ── the exact value that shipped ────────────────────────────────────────────
check('the live junk is rejected', cleanAuthor(`${SLUG}" data-astro-c`, 'alkhabrlive'), null);
check('…and via the full cascade',
  extractAuthorFromHtml(`<article><a href="/author/${SLUG}" data-astro-cid-zetdpzsg>${SLUG}" data-astro-c</a></article>`, 'alkhabrlive'),
  null);

// ── markup residue in general, whichever source offers it ───────────────────
check('an Astro cid attribute', cleanAuthor('data-astro-cid-zetdpzsg', null), null);
check('an attribute pair', cleanAuthor('href="/x" class="y"', null), null);
check('an unclosed quote + attribute', cleanAuthor('Ahmed" data-x', null), null);
check('an angle bracket', cleanAuthor('Ahmed > Sara', null), null);
check('a style fragment', cleanAuthor('style=color:red', null), null);
check('an aria attribute', cleanAuthor('aria-label', null), null);

// A bare slug reaches the meta path too — no quote to catch it, so the
// hyphen-count rule is what rejects it.
check('a bare URL slug from a meta', extractAuthorFromHtml(`<meta name="author" content="${SLUG}">`), null);
check('a Latin slug', cleanAuthor('privacy-policy-and-terms', null), null);

// ── real bylines must be untouched ──────────────────────────────────────────
// The page that prompted this reports "Mohamed Hamada"; the guard must not be
// what stops it being found.
check('the page\'s real byline', cleanAuthor('Mohamed Hamada', 'alkhabrlive'), 'Mohamed Hamada');
check('…from a meta tag', extractAuthorFromHtml('<meta name="author" content="Mohamed Hamada">'), 'Mohamed Hamada');
check('…from an /author/ link',
  extractAuthorFromHtml('<article><a href="/author/mohamed-hamada" data-astro-cid-zetdpzsg>Mohamed Hamada</a></article>', 'alkhabrlive'),
  'Mohamed Hamada');

// Word COUNT must stay uncapped on the single-segment path: Egyptian bylines
// routinely run to five parts, and looksLikePerson's 2–4 cap guards the
// multi-segment split, not this one. Capping here would silently drop them.
check('a three-part Arabic name', cleanAuthor('محمد عبد الرحمن', null), 'محمد عبد الرحمن');
check('a five-part Arabic name', cleanAuthor('أحمد محمد عبد الله السيد', null), 'أحمد محمد عبد الله السيد');
check('an initial with a full stop', cleanAuthor('Doaa A.Moneim', null), 'Doaa A.Moneim');
check('a hyphenated given name', cleanAuthor('Jean-Pierre Aoun', null), 'Jean-Pierre Aoun');
check('a doubly hyphenated pair', cleanAuthor('Abdel-Rahman El-Sayed', null), 'Abdel-Rahman El-Sayed');
check('an apostrophe surname', cleanAuthor("Sara O'Brien", null), "Sara O'Brien");

// The earlier junk classes still hold — this guard is additive, not a rewrite.
check('an email is still rejected', cleanAuthor('admin@site.com', null), null);
check('an outlet name is still rejected', cleanAuthor('بوابة الأخبار', null), null);
check('a desk byline is still rejected', cleanAuthor('محرر', null), null);

console.log(`\n${pass}/22 PASS — markup residue and URL slugs can never be a byline; real names, including five-part Arabic ones, are untouched`);
assert.strictEqual(pass, 22, 'not all 22 passed');
