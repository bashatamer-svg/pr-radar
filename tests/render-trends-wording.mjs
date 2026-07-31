// Sentiment is the tone for the brand a story is ABOUT — the same scale for
// Vodafone and for rivals, never inverted. So every Trends surface names it
// plainly: Negative / Neutral / Positive. This test pins that wording and
// guards against the retired "unfavourable / favourable" vocabulary, which
// existed only to paper over the old Vodafone-standpoint inversion.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const days = ['2026-07-28', '2026-07-29', '2026-07-30'];
const series = (m, n) => ({ mentions: m, negatives: n });
const STATS = {
  meta: { days: 7, generatedAt: new Date().toISOString(), items: 12 },
  days,
  sov: {
    Vodafone: series([2, 1, 1], [1, 0, 0]),
    Orange: series([1, 2, 1], [0, 2, 1]),   // Orange's own bad press
    WE: series([1, 1, 0], [1, 0, 0]),
    'e&': series([0, 1, 1], [0, 1, 1]),
    Market: series([0, 0, 0], [0, 0, 0]),
  },
  sentimentByBrand: {
    Vodafone: { negative: 1, neutral: 2, positive: 1, total: 4 },
    Orange: { negative: 3, neutral: 1, positive: 0, total: 4 },
    WE: { negative: 1, neutral: 1, positive: 0, total: 2 },
    'e&': { negative: 2, neutral: 0, positive: 0, total: 2 },
  },
  categories: [{ category: 'corporate', total: 5, negative: 3, vodNeg: 1, series: [1, 2, 2] }],
  narratives: [{ name: 'WE search ranking', brand: 'WE', total: 3, negative: 3, neutral: 0, positive: 0, series: [1, 1, 1], ids: [1, 2] }],
  // One row shown out of several that exist — the leaderboards are a top-N view.
  outlets: [{ outlet: 'Youm7', mentions: 4, negative: 3, neutral: 1, positive: 0, vodNeg: 1, series: [1, 2, 1] }],
  authors: [{ author: 'Sara', outlets: ['Youm7'], mentions: 4, negative: 3, neutral: 1, positive: 0, vodNeg: 1, series: [1, 2, 1] }],
  totals: { items: 12, negatives: 7, positives: 1, neutrals: 4, vodafone: { mentions: 4, negatives: 1 }, distinctOutlets: 3, distinctAuthors: 9, itemsWithByline: 5 },
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATS)); return; }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8935, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8935/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('.cardc', { timeout: 5000 });

const text = await page.evaluate(() => document.body.innerText);

// the per-brand chart that plots negatives says exactly that
assert.ok(/Negative coverage/.test(text), 'the negatives-per-brand chart is titled "Negative coverage"');
assert.ok(/negative stories per brand/.test(text), 'its subtitle says what the series are');
// the sentiment split legend uses the plain sentiment words
assert.ok(/Negative/.test(text) && /Positive/.test(text), 'sentiment legend reads Negative / Positive');
// the Vodafone-only KPI is unchanged
assert.ok(/Vodafone negative/.test(text), 'Vodafone-scoped KPI still says "Vodafone negative"');

// The retired standpoint vocabulary must not survive anywhere on the page — it
// only made sense while competitor sentiment was inverted.
for (const gone of [/unfavourable/i, /favourable/i, /against us/i, /rivals’ wins/]) {
  assert.ok(!gone.test(text), `retired wording still on the Trends page: ${gone}`);
}

// A leaderboard that stops at N must SAY it stopped, and name the true total —
// "15 journalists" over a 100-story window reads as missing data unless the
// page explains it is a top-N slice (asked about live, 2026-07-31).
assert.ok(/top 1 of 9 journalists/.test(text), `journalist card declares the cap and the true total (got: ${text.match(/Journalist intelligence[^\n]*/) || 'n/a'})`);
assert.ok(/top 1 of 3 outlets/.test(text), 'outlet card declares the cap and the true total');
// …and the OTHER half of the gap: most desk/wire copy carries no byline at all.
assert.ok(/5 of 12 stories in this window are signed/.test(text), 'the footnote explains why journalists are fewer than stories');

// a11y data tables carry the same plain wording
const heads = await page.evaluate(() => {
  document.querySelectorAll('.tgl').forEach((b) => b.click());
  return [...document.querySelectorAll('table th')].map((t) => t.textContent.trim());
});
assert.ok(heads.includes('Negative') && heads.includes('Positive'), `data tables use Negative/Positive (got ${heads.join(',')})`);
assert.ok(!heads.includes('Unfavourable') && !heads.includes('Favourable'), `no standpoint wording in table headers (got ${heads.join(',')})`);

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('TRENDS-WORDING OK — charts, legend, rows and data tables read "negative / positive"; no inverted-standpoint vocabulary left on the page');
