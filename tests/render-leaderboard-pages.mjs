// The Trends leaderboards page through EVERY outlet and journalist, 15 at a
// time. Before this they stopped at 15 rows with no way forward, which read as
// "we only found 15 journalists" over a 100-story window (asked live).
//
// What matters and is pinned here: every row is reachable, the counter tells
// the truth on each page, the buttons dead-end correctly, the table view shows
// the SAME page as the list, bar widths stay comparable across pages, and
// changing the time window resets you to page 1.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const days = ['2026-07-29', '2026-07-30', '2026-07-31'];

// 38 journalists and 7 outlets: one list needs three pages (15/15/8), the other
// fits on a single page and must therefore show NO pager at all.
// Sentiment counts sum to `mentions`, as they do in real data — the row bar is
// those three segments, so anything else would make bar length meaningless.
const row = (n, i) => {
  const mentions = n - i, negative = i % 3;
  return { mentions, negative, neutral: mentions - negative, positive: 0, vodNeg: i % 2, series: [1, 1, 1] };
};
const mkAuthors = (n) => Array.from({ length: n }, (_, i) => ({
  author: `Writer ${String(i + 1).padStart(2, '0')}`, outlets: ['Youm7'], ...row(n, i),
}));
const mkOutlets = (n) => Array.from({ length: n }, (_, i) => ({
  outlet: `Outlet ${String(i + 1).padStart(2, '0')}`, ...row(n, i),
}));

const statsFor = (nAuthors, nOutlets) => ({
  meta: { days: 30, generatedAt: new Date().toISOString(), items: 100 },
  days,
  sov: { Vodafone: { mentions: [1, 1, 1], negatives: [0, 0, 0] }, Orange: { mentions: [0, 0, 0], negatives: [0, 0, 0] }, WE: { mentions: [0, 0, 0], negatives: [0, 0, 0] }, 'e&': { mentions: [0, 0, 0], negatives: [0, 0, 0] }, Market: { mentions: [0, 0, 0], negatives: [0, 0, 0] } },
  sentimentByBrand: { Vodafone: { negative: 1, neutral: 1, positive: 1, total: 3 } },
  categories: [{ category: 'corporate', total: 3, negative: 1, vodNeg: 1, series: [1, 1, 1] }],
  narratives: [],
  outlets: mkOutlets(nOutlets),
  authors: mkAuthors(nAuthors),
  totals: { items: 100, negatives: 10, positives: 5, neutrals: 85, vodafone: { mentions: 40, negatives: 4 }, distinctOutlets: nOutlets, distinctAuthors: nAuthors, itemsWithByline: 50 },
});

// The 7-day window returns a SMALLER set — used to prove the page resets.
let big = statsFor(38, 7);
const small = statsFor(3, 3);

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u.searchParams.get('days') === '7' ? small : big));
    return;
  }
  if (u.pathname === '/api/auth') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}');
    return;
  }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8941, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' }));
  localStorage.setItem('pr_stats_days', '30');
});
await page.goto('http://localhost:8941/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('#c-auth .lrow', { timeout: 5000 });

const names = () => page.$$eval('#c-auth .lrow .nm', (els) => els.map((e) => e.childNodes[0].textContent.trim()));
const counter = () => page.$eval('#c-auth .pgn', (e) => e.textContent.trim());
const nextBtn = () => page.$('#c-auth .pager .pg[aria-label^="Next"]');
const prevBtn = () => page.$('#c-auth .pager .pg[aria-label^="Previous"]');
const disabled = async (h) => (h ? h.isDisabled() : true);

// ── page 1 ──
assert.strictEqual((await names()).length, 15, 'page 1 shows 15 journalists');
assert.strictEqual(await counter(), '1–15 of 38', `counter reads the true range (got ${await counter()})`);
assert.ok(await disabled(await prevBtn()), 'Prev is dead on the first page');
assert.ok(!(await disabled(await nextBtn())), 'Next is live on the first page');
const p1 = await names();
assert.strictEqual(p1[0], 'Writer 01', 'the busiest journalist leads page 1 — sort order is unchanged');
// The subtitle no longer claims to be a top-N slice: nothing is withheld now.
const sub = await page.$eval('#c-auth .chead .cs', (e) => e.textContent);
assert.ok(/38 journalists/.test(sub) && !/top/.test(sub), `subtitle states the full count (got "${sub}")`);

// ── walk to the end ──
await (await nextBtn()).click();
assert.strictEqual(await counter(), '16–30 of 38', 'page 2 counter');
const p2 = await names();
assert.strictEqual(p2.length, 15, 'page 2 shows 15');
assert.strictEqual(p2[0], 'Writer 16', 'page 2 continues where page 1 stopped — no row skipped or repeated');

await (await nextBtn()).click();
assert.strictEqual(await counter(), '31–38 of 38', 'last page counter reports the short page honestly');
const p3 = await names();
assert.strictEqual(p3.length, 8, 'the last page holds the remainder, not a padded 15');
assert.ok(await disabled(await nextBtn()), 'Next dead-ends on the last page');
assert.ok(!(await disabled(await prevBtn())), 'Prev is live on the last page');

// Every one of the 38 is reachable, exactly once — the whole point of the change.
const seen = [...p1, ...p2, ...p3];
assert.strictEqual(new Set(seen).size, 38, `all 38 journalists are reachable across the pages (saw ${new Set(seen).size})`);

// ── the table view shows the SAME page, not the whole list ──
await page.click('#c-auth .tgl');
const tableRows = await page.$$eval('#c-auth .tbl tbody tr td:first-child', (els) => els.map((e) => e.textContent.trim()));
assert.deepStrictEqual(tableRows, p3, 'the table view mirrors the page on screen');
assert.ok(/31–38 of 38/.test(await page.$eval('#c-auth .tbl caption', (e) => e.textContent)), 'the table caption states the same range');
await page.click('#c-auth .tgl');

// ── bars stay comparable across pages ──
// Width is relative to the busiest row in the WHOLE list, so the quietest
// journalist on the last page must not draw a full-width bar.
await (await prevBtn()).click(); await (await prevBtn()).click();
const barWidth = () => page.$eval('#c-auth .lrow .bar', (e) =>
  [...e.querySelectorAll('i')].reduce((t, i) => t + parseFloat(i.style.width || 0), 0));
const w1 = await barWidth();
await (await nextBtn()).click(); await (await nextBtn()).click();
const w3 = await barWidth();
assert.ok(w1 > w3 * 2, `the busiest row (page 1) draws a far longer bar than a quiet one (page 3): ${w1}% vs ${w3}%`);
assert.ok(w1 <= 100.5, `no bar exceeds full width (${w1}%)`);

// ── a short list gets no pager at all ──
assert.strictEqual(await page.$('#c-out .pager'), null, '7 outlets fit on one page, so no pager is drawn');
assert.strictEqual((await page.$$('#c-out .lrow')).length, 7, 'all 7 outlets shown at once');

// ── changing the window resets to page 1 ──
// (we are on the LAST page here — step back one, since Next is disabled)
await (await prevBtn()).click();
assert.strictEqual(await counter(), '16–30 of 38', 'on page 2 before switching window');
await page.click('#winRow .chip[data-v="7"]');
await page.waitForFunction(() => document.querySelectorAll('#c-auth .lrow').length === 3, { timeout: 5000 });
assert.strictEqual(await page.$('#c-auth .pager'), null, 'the smaller window needs no pager');
assert.strictEqual((await names()).length, 3, 'the smaller window renders its 3 journalists, not a stale page 2');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('LEADERBOARD-PAGES OK — all 38 journalists reachable across 3 pages (15/15/8), counter + button states honest, table mirrors the page, bars comparable across pages, short lists get no pager, window change resets to page 1');
