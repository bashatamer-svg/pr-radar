// VERIFY step 3 — 26 author unit checks (must be 26/26).
import assert from 'node:assert';
import { extractAuthorFromHtml, cleanAuthor, fetchAuthorProbe } from '../lib/author.js';
import { isNonArticlePage } from '../lib/resolve.js';

let pass = 0;
const check = (label, actual, expected) => {
  assert.strictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  pass++; console.log(`  ✓ ${label}`);
};

// 1. meta reversed attribute order
check('meta reversed order', extractAuthorFromHtml('<meta content="Sara Aggour" name="author">'), 'Sara Aggour');
// 2. meta normal order
check('meta normal order', extractAuthorFromHtml('<meta name="author" content="Sara Aggour">'), 'Sara Aggour');
// 3. article:author URL rejected → falls through to null
check('article:author URL rejected', extractAuthorFromHtml('<meta property="article:author" content="https://facebook.com/dne">'), null);
// 4. Arabic byline, no separator
check('كتب no-separator', extractAuthorFromHtml('<p>كتب محمد عبد الرحمن</p>'), 'محمد عبد الرحمن');
// 5. stop-word guard — a sentence, not a name
check('stop-word guard', extractAuthorFromHtml('<p>كتب المقال عن الاقتصاد المصري</p>'), null);
// 6. بقلم with colon separator
check('بقلم: أحمد سمير', extractAuthorFromHtml('<div class="byline">بقلم: أحمد سمير</div>'), 'أحمد سمير');
// 7. JSON-LD beats meta (different names → JSON-LD wins)
check('JSON-LD beats meta',
  extractAuthorFromHtml('<script type="application/ld+json">{"author":{"name":"Mona Zaki"}}</script><meta name="author" content="Someone Else">'),
  'Mona Zaki');
// 8. cleanAuthor salvages person from compound desk byline (Arabic)
check('cleanAuthor محمد علي - خاص', cleanAuthor('محمد علي - خاص', 'المال'), 'محمد علي');
// 9. cleanAuthor pure outlet-desk → null
check('cleanAuthor المال - خاص', cleanAuthor('المال - خاص', 'المال'), null);
// 10. cleanAuthor outlet-as-author → null
check('cleanAuthor Techno Time', cleanAuthor('Techno Time', 'Technotime'), null);
// 11. cleanAuthor English compound "Al-Mal - John Smith" → person
check('cleanAuthor Al-Mal - John Smith', cleanAuthor('Al-Mal - John Smith', 'Al-Mal'), 'John Smith');
// 12. cleanAuthor plain person passes through
check('cleanAuthor plain person', cleanAuthor('Ahmed Salah', 'Youm7'), 'Ahmed Salah');
// 13. rel=author visible byline
check('rel=author byline', extractAuthorFromHtml('<a rel="author" href="/x">Nourhan Fahmy</a>'), 'Nourhan Fahmy');
// 14. UI junk — search-box placeholder scraped as byline (the real production
//     bug: "كلمة البحث هنا" = "search word here", Sada El-Balad's template)
check('UI junk كلمة البحث هنا', cleanAuthor('كلمة البحث هنا', 'صدى البلد'), null);
// 15. UI junk — English template furniture
check('UI junk Search Keywords', cleanAuthor('Search Keywords', 'Youm7'), null);
// 16. هنا is ALSO a real given name — must still pass as a person
check('هنا الزاهد still a person', cleanAuthor('هنا الزاهد', 'Youm7'), 'هنا الزاهد');
// 17-19. non-article pages: tag/keyword archives caught, WP permalink NOT
check('keyword page flagged', isNonArticlePage('https://besraha.com/keyword/318029/1'), true);
check('tag page flagged', isNonArticlePage('https://elghad.news/tag/%D8%B4%D8%B1%D9%83%D8%A9/'), true);
check('WP /archives/ permalink NOT flagged', isNonArticlePage('https://alahalygate.com/archives/341270'), false);
// 20b/20c. a bare email address is a CMS account, not a byline (production
//     case: "melfaramawy416@gmail.com" rendered as a journalist) — but the
//     "Name <email>" feed shape still yields the human part.
check('bare email rejected', cleanAuthor('melfaramawy416@gmail.com', 'ekhbary24'), null);
check('Name <email> keeps the name', cleanAuthor('Ahmed Salah <a.salah@youm7.com>', 'Youm7'), 'Ahmed Salah');
// FIRST VALID WINS: junk in a high-priority source must never mask a real
// byline in a lower one — the PERMANENT fix for the whole class (ekhbary24's
// CMS email was one species; outlet names and UI placeholders are others).
check('email meta falls through to visible byline',
  extractAuthorFromHtml('<meta name="author" content="melfaramawy416@gmail.com"><p>كتب: أحمد عبد السلام</p>'),
  'أحمد عبد السلام');
check('outlet-name meta falls through to visible byline',
  extractAuthorFromHtml('<meta name="author" content="بوابة الأهرام"><div class="byline">بقلم: سارة حسن</div>'),
  'سارة حسن');
check('UI-junk JSON-LD falls through to meta person',
  extractAuthorFromHtml('<script type="application/ld+json">{"author":{"name":"كلمة البحث هنا"}}</script><meta name="author" content="Mona Zaki">'),
  'Mona Zaki');
check('outlet param sharpens the outlet check',
  extractAuthorFromHtml('<meta name="author" content="Techno Time"><p>كتب: أحمد سمير</p>', 'Technotime'),
  'أحمد سمير');
// 20. probe refuses to scrape a non-article page (no fetch attempted)
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('must not fetch a tag page'); };
const probe = await fetchAuthorProbe('https://besraha.com/keyword/318029/1');
assert.strictEqual(fetches, 0, 'probe fetched a tag page');
check('probe skips tag page', `${probe.author}|${probe.outcome}`, 'null|no-byline');

console.log(`\n${pass}/26 PASS`);
assert.strictEqual(pass, 26, 'not all 26 passed');
