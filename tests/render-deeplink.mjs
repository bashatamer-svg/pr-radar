// Trends → board deep links: cat / outlet / author filters + clear.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'Cash outage', summary: 's', sentiment: 'negative', importance: 5, category: 'vodafone_cash', url: 'u', resolved_url: 'u', published_at: now, author: 'محمد علي', instances: [{ outlet: 'Youm7', author: 'محمد علي', url: 'u' }] },
  { id: 2, brand: 'Vodafone', headline: 'Vodafone campaign', summary: 's', sentiment: 'positive', importance: 3, category: 'campaign', url: 'u', resolved_url: 'u', published_at: now, author: 'Sara', instances: [{ outlet: 'Masrawy', author: 'Sara', url: 'u' }] },
  { id: 3, brand: 'Orange', headline: 'Orange corporate', summary: 's', sentiment: 'positive', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [{ outlet: 'Youm7', author: 'Sara', url: 'u' }] },
];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"totals":{"items":0}}'); return; }
  if (u.pathname === '/stats') { const b = readFileSync(DIR + '/stats.html'); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); return; }
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"email":"a@b.com","role":"admin","kind":"user"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"supabaseUrl":"","anonKey":""}'); return;
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8913, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const openBoard = async (qs) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  page.on('pageerror', (e) => errs.push(qs + ':' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
  await page.goto('http://localhost:8913/' + qs, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card, .empty', { timeout: 4000 });
  return page;
};
const ids = async (page) => (await page.$$eval('.card', els => els.map(e => e.id))).sort();

// category filter
let page = await openBoard('?cat=vodafone_cash&win=30');
assert.deepStrictEqual(await ids(page), ['item-1'], 'cat=vodafone_cash → only item 1');
assert.ok(await page.$eval('#dfilter', el => el.classList.contains('on')), 'deep-filter banner shown');
assert.ok(/vodafone cash/i.test(await page.$eval('#dfilter', el => el.textContent)), 'banner names the category');
await page.click('#dfilter .dfx');   // clear
await page.waitForTimeout(150);
assert.strictEqual((await page.$$('.card')).length, 3, 'clearing the filter shows all cards');
assert.ok(!(await page.$eval('#dfilter', el => el.classList.contains('on'))), 'banner hidden after clear');
assert.ok(!/cat=/.test(await page.evaluate(() => location.search)), 'cat param stripped from URL on clear');
await page.close();

// outlet filter → both items that ran in Youm7
page = await openBoard('?outlet=Youm7&win=30');
assert.deepStrictEqual(await ids(page), ['item-1', 'item-3'], 'outlet=Youm7 → items 1 and 3');
await page.close();

// author filter → both items by Sara
page = await openBoard('?author=Sara&win=30');
assert.deepStrictEqual(await ids(page), ['item-2', 'item-3'], 'author=Sara → items 2 and 3');
await page.close();

// narrative ids → exact stories, banner labelled
page = await openBoard('?ids=1,3&label=' + encodeURIComponent('Cash saga') + '&win=30');
assert.deepStrictEqual(await ids(page), ['item-1', 'item-3'], 'ids=1,3 → items 1 and 3');
assert.ok(/narrative/i.test(await page.$eval('#dfilter', el => el.textContent)) && /cash saga/i.test(await page.$eval('#dfilter', el => el.textContent)), 'banner shows the narrative label');
await page.close();

// A narrative bigger than the id list it shipped must SAY it is a subset —
// showing fewer cards than the Trends row promised, with no explanation, is
// exactly the bug this guards (a 27-story narrative opening as 20 cards).
page = await openBoard('?ids=1,3&label=' + encodeURIComponent('Big saga') + '&n=27&win=30');
const subsetTxt = await page.$eval('#dfilter', el => el.textContent.replace(/\s+/g, ' '));
assert.ok(/top 2 of 27/.test(subsetTxt), `banner declares the subset (got "${subsetTxt}")`);
await page.close();

// …and when the ids are complete, no subset note appears.
page = await openBoard('?ids=1,3&label=' + encodeURIComponent('Whole saga') + '&n=2&win=30');
assert.ok(!/top \d+ of/.test(await page.$eval('#dfilter', el => el.textContent)), 'no subset note when every story was shipped');
await page.close();

// unknown value → empty with the clear affordance
page = await openBoard('?outlet=Nobody&win=30');
assert.strictEqual((await page.$$('.card')).length, 0, 'unknown outlet → no cards');
assert.ok(await page.$eval('#dfilter', el => el.classList.contains('on')), 'banner still shown so the user can clear');
await page.close();

// stats rows generate the right board links
{
  const p = await browser.newPage();
  p.on('pageerror', (e) => errs.push('stats:' + e.message));
  await p.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
  await p.goto('http://localhost:8913/stats', { waitUntil: 'networkidle' });
  const out = await p.evaluate(() => {
    DATA = {
      meta: { days: 30 },
      totals: { items: 10, negatives: 3, distinctOutlets: 5, vodafone: { mentions: 4, negatives: 1 } },
      categories: [{ category: 'vodafone_cash', total: 3, negative: 1, vodNeg: 1, series: [1, 2, 0] }],
      outlets: [{ outlet: 'Youm7', mentions: 4, negative: 1, neutral: 2, positive: 1, vodNeg: 1, series: [1, 1, 2] }],
      authors: [{ author: 'Sara', mentions: 2, negative: 0, neutral: 1, positive: 1, vodNeg: 0, outlets: ['Youm7'], series: [1, 1] }],
      narratives: [{ name: 'Cash saga', brand: 'Vodafone', category: 'vodafone_cash', total: 3, negative: 3, neutral: 0, positive: 0, series: [1, 2, 0], ids: [1, 3, 7], headline: 'x' }],
    };
    return {
      cat: categoryRows().rows, out: leaderboardRows(DATA.outlets, 'outlet').rows, auth: leaderboardRows(DATA.authors, 'author').rows,
      narr: narrativeRows(DATA.narratives).rows, kpi: kpiHtml(), leg: legendHtml(['Vodafone', 'Orange', 'Market'], 'rect'),
    };
  });
  assert.ok(/<a class="lrow" href="\/\?cat=vodafone_cash&win=\d+"/.test(out.cat), 'category row links to /?cat=');
  assert.ok(/<a class="lrow" href="\/\?outlet=Youm7&win=\d+"/.test(out.out), 'outlet row links to /?outlet=');
  assert.ok(/<a class="lrow" href="\/\?author=Sara&win=\d+"/.test(out.auth), 'author row links to /?author=');
  assert.ok(/<a class="lrow narr" href="\/\?ids=1,3,7&label=Cash%20saga&n=3&win=\d+"/.test(out.narr), 'narrative row links to /?ids= its stories and passes the true total as n=');
  assert.ok(/<span class="nm" dir="auto"/.test(out.narr), 'narrative name renders with dir=auto (correct RTL)');
  assert.ok(/<a class="kpi" href="\/\?sent=negative&win=\d+"/.test(out.kpi), 'Needs-response KPI links to /?sent=negative');
  // Vodafone-only count: test data has all-brand negatives=3 but vodafone.negatives=1.
  assert.ok(/Needs response<\/div><div class="kv[^"]*">1</.test(out.kpi), 'Needs-response KPI shows the Vodafone negative count (1), matching the board lane');
  assert.ok(!/Needs response<\/div><div class="kv[^"]*">3</.test(out.kpi), 'Needs-response KPI is NOT the all-brand negative count (3)');
  assert.ok(/<a class="kpi" href="\/\?brand=Vodafone&win=\d+"/.test(out.kpi), 'Vodafone SoV KPI links to /?brand=Vodafone');
  assert.ok(/<a class="li" href="\/\?brand=Vodafone&win=\d+"/.test(out.leg) && /<a class="li" href="\/\?brand=Orange&win=\d+"/.test(out.leg), 'brand legend items link to /?brand=');
  assert.ok(/<span class="li">.*Market/.test(out.leg), "Market legend item is not a link");
  await p.close();
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('DEEP-LINK OK — board filters by cat/outlet/author from the URL, banner + clear work; stats rows link back');
