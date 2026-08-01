// Trends export: every section out as a spreadsheet (tables) or a print-ready
// page (charts + tables). Both are built in the browser from the same DATA the
// screen renders, so there is no second aggregation to disagree with it.
//
// What matters and is pinned here: the export carries EVERY row rather than the
// leaderboard page you happen to be on, the workbook declares one worksheet per
// section with names Excel will accept, and the print page embeds each chart's
// real SVG — without mistaking a row sparkline for a section chart.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const days = ['2026-07-29', '2026-07-30', '2026-07-31'];
const series = (m, n) => ({ mentions: m, negatives: n });
// 38 journalists: more than the 15-a-page leaderboard, so a paged export shows.
const lb = (name, n) => Array.from({ length: n }, (_, i) => ({
  [name]: `${name} ${String(i + 1).padStart(2, '0')}`, outlets: ['Youm7'],
  mentions: n - i, negative: i % 3, neutral: 2, positive: 1, vodNeg: i % 2, series: [1, 1, 1],
}));

const STATS = {
  meta: { days: 30, generatedAt: new Date().toISOString(), items: 100 },
  days,
  sov: {
    Vodafone: series([2, 1, 1], [1, 0, 0]), Orange: series([1, 2, 1], [0, 2, 1]),
    WE: series([1, 1, 0], [1, 0, 0]), 'e&': series([0, 1, 1], [0, 1, 1]), Market: series([0, 0, 0], [0, 0, 0]),
  },
  sentimentByBrand: {
    Vodafone: { negative: 1, neutral: 2, positive: 1, total: 4 }, Orange: { negative: 3, neutral: 1, positive: 0, total: 4 },
    WE: { negative: 1, neutral: 1, positive: 0, total: 2 }, 'e&': { negative: 2, neutral: 0, positive: 0, total: 2 },
    Market: { negative: 0, neutral: 0, positive: 0, total: 0 },
  },
  categories: [{ category: 'vodafone_cash', total: 5, negative: 3, vodNeg: 1, series: [1, 2, 2] }],
  narratives: [{ name: 'Al-Ahly stadium naming', brand: 'Vodafone', total: 3, negative: 0, neutral: 1, positive: 2, series: [1, 1, 1], ids: [1, 2, 3], rising: true }],
  outlets: lb('outlet', 22),
  authors: lb('author', 38),
  totals: { items: 100, negatives: 7, positives: 1, neutrals: 92, vodafone: { mentions: 4, negatives: 1 }, distinctOutlets: 22, distinctAuthors: 38, itemsWithByline: 50 },
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATS)); return; }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(DIR + f)); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8963, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, acceptDownloads: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' }));
  localStorage.setItem('pr_stats_days', '30');
});
await page.goto('http://localhost:8963/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('.cardc');

// Export lives on each CARD, not in a page-wide bar — you export the section
// you are looking at.
assert.strictEqual(await page.$('#xlsBtn'), null, 'no page-wide Excel button');
assert.strictEqual(await page.$('#expRow'), null, 'no page-wide export row');
const cards = await page.$$eval('.cardc', (els) => els.map((e) => e.id));
for (const id of cards) {
  assert.ok(await page.$(`#${id} .xp[data-fmt="xls"]`), `${id} has its own Excel button`);
  assert.ok(await page.$(`#${id} .xp[data-fmt="pdf"]`), `${id} has its own PDF button`);
}

const out = await page.evaluate(() => {
  const secs = exportSections();
  return {
    sections: secs.map((s) => ({ title: s.title, cols: s.headers.length, rows: s.rows.length, id: s.id })),
    xls: xlsDoc(secs),
    pdf: printDoc(secs),
  };
});
const byTitle = Object.fromEntries(out.sections.map((s) => [s.title, s]));

// ── every section is there ──
for (const t of ['Summary', 'Share of voice', 'Negative coverage', 'Sentiment by brand', 'Narratives', 'Categories', 'Outlets', 'Journalists']) {
  assert.ok(byTitle[t], `section exported: ${t} (got ${out.sections.map((s) => s.title).join(', ')})`);
}

// ── the whole list, not the page on screen ──
assert.strictEqual(byTitle.Journalists.rows, 38, `all 38 journalists export, not the 15 on screen (got ${byTitle.Journalists.rows})`);
assert.strictEqual(byTitle.Outlets.rows, 22, `all 22 outlets export (got ${byTitle.Outlets.rows})`);
assert.strictEqual(byTitle['Share of voice'].rows, days.length, 'one row per day in the window');
// Every row must be the width of its header, or the columns shift in Excel.
const widths = await page.evaluate(() => exportSections().map((s) => s.rows.every((r) => r.length === s.headers.length)));
assert.ok(widths.every(Boolean), 'every row matches its header width');

// ── workbook: one worksheet per section, named legally ──
const names = [...out.xls.matchAll(/<x:Name>([^<]+)<\/x:Name>/g)].map((m) => m[1]);
assert.strictEqual(names.length, out.sections.length, `one worksheet per section (got ${names.length} for ${out.sections.length})`);
for (const n of names) {
  assert.ok(n.length <= 31, `worksheet name within Excel's 31-char limit: "${n}"`);
  assert.ok(!/[[\]:*?/\\]/.test(n), `worksheet name has no character Excel rejects: "${n}"`);
}
// …and each table is labelled, so a reader that flattens the workbook into one
// sheet still gets separated, named sections instead of tables running together.
for (const t of ['Journalists', 'Categories']) {
  assert.ok(out.xls.includes(`>${t}<`), `the workbook labels the ${t} table`);
}
assert.ok(/xmlns:x="urn:schemas-microsoft-com:office:excel"/.test(out.xls), 'declared as an Excel workbook');

// ── print page: charts AND tables ──
// A chart section embeds its real SVG; a list section must NOT, or the first
// row's sparkline gets pasted in as though it were the section chart.
const svgCount = (out.pdf.match(/<svg/g) || []).length;
assert.ok(svgCount >= 3, `the three chart sections embed their SVGs (found ${svgCount})`);
assert.ok(svgCount <= 4, `list sections do not smuggle a row sparkline in as a chart (found ${svgCount})`);
for (const t of ['Summary', 'Narratives', 'Journalists', 'Outlets']) {
  assert.ok(out.pdf.includes(`<h2>${t}</h2>`), `the print page carries the ${t} section`);
}
assert.ok(out.pdf.includes('author 38'), 'the print page also carries every row, not just the visible page');
assert.ok(/@page\{size:A4/.test(out.pdf), 'print page sets a page size');
assert.ok(/window\.print\(\)/.test(out.pdf), 'the print dialog is triggered on open');

// ── a card's button downloads THAT card only, named after it ──
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }),
  page.click('#c-auth .xp[data-fmt="xls"]'),
]);
assert.ok(/^pr-radar-journalists-30d-\d{4}-\d{2}-\d{2}\.xls$/.test(download.suggestedFilename()),
  `the file is named after the section, window and date (got ${download.suggestedFilename()})`);
// …and it contains only that section — one worksheet, the journalists.
const one = await page.evaluate(() => ({ xls: xlsDoc(sectionsFor('c-auth')), pdf: printDoc(sectionsFor('c-auth')) }));
const oneNames = [...one.xls.matchAll(/<x:Name>([^<]+)<\/x:Name>/g)].map((m) => m[1]);
assert.deepStrictEqual(oneNames, ['Journalists'], `a card exports itself alone (got ${JSON.stringify(oneNames)})`);
assert.ok(one.xls.includes('author 38'), 'and still every row of it');
assert.ok(!one.pdf.includes('<h2>Outlets</h2>'), 'a card export does not drag in its neighbours');
// A chart card carries its chart; a list card has none to carry.
const sov = await page.evaluate(() => printDoc(sectionsFor('c-sov')));
assert.ok(/<svg/.test(sov), 'a chart card exports its chart');
assert.ok(!/<svg/.test(one.pdf), 'a list card exports its table without a stray sparkline');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log(`TRENDS-EXPORT OK — ${out.sections.length} sections to Excel (one worksheet each, legal names, all 38 journalists not the 15 on screen) and to a print page carrying the 3 real chart SVGs plus every table; download named ${download.suggestedFilename()}`);
