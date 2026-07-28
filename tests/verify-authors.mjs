// VERIFY step 3 — 13 author unit checks (must be 13/13).
import assert from 'node:assert';
import { extractAuthorFromHtml, cleanAuthor } from '../lib/author.js';

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

console.log(`\n${pass}/13 PASS`);
assert.strictEqual(pass, 13, 'not all 13 passed');
