// Trends must never label a COMPETITOR series "negative": tone is measured from
// Vodafone's standpoint, so a rival's negative is that rival WINNING. Every
// mixed-brand surface reads "against us" / "in our favour"; only the explicitly
// Vodafone-scoped KPI keeps the plain word.
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
    Orange: series([1, 2, 1], [0, 2, 1]),   // rival wins
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
  outlets: [{ outlet: 'Youm7', mentions: 4, negative: 3, neutral: 1, positive: 0, vodNeg: 1, series: [1, 2, 1] }],
  authors: [{ author: 'Sara', outlets: ['Youm7'], mentions: 4, negative: 3, neutral: 1, positive: 0, vodNeg: 1, series: [1, 2, 1] }],
  totals: { items: 12, negatives: 7, positives: 1, neutrals: 4, vodafone: { mentions: 4, negatives: 1 }, distinctOutlets: 3 },
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

// the per-brand chart that plots negatives is framed as "against us"
assert.ok(/Coverage against us/.test(text), 'the negatives-per-brand chart is titled "Coverage against us"');
assert.ok(/rivals’ wins/.test(text), 'its subtitle explains the mix (our negatives + rivals\' wins)');
// the sentiment split legend uses standpoint wording, not bare sentiment
assert.ok(/Against us/.test(text) && /In our favour/.test(text), 'sentiment legend reads from Vodafone\'s standpoint');
// the Vodafone-only KPI keeps the plain word — it is unambiguous there
assert.ok(/Vodafone negative/.test(text), 'Vodafone-scoped KPI still says "Vodafone negative"');

// No mixed-brand surface may show a bare "Negative"/"Positive"/"neg" label.
// Explicitly Vodafone-scoped labels (e.g. "3 Vod-neg") are fine — the brand is
// named, so there is nothing to misread.
const bare = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.legend a, .chead .ct, .chead .cs, .lrow .val, .kpi .kl').forEach((el) => {
    const t = el.textContent.trim();
    if (/vod/i.test(t)) return;                       // Vodafone-scoped: allowed
    if (/^(Negative|Positive)$/i.test(t) || /\bneg\b/i.test(t)) out.push(t);
  });
  return out;
});
assert.deepStrictEqual(bare, [], `no bare sentiment labels on mixed-brand surfaces (found: ${bare.join(' | ')})`);

// a11y data tables carry the same wording
const heads = await page.evaluate(() => {
  document.querySelectorAll('.tgl').forEach((b) => b.click());
  return [...document.querySelectorAll('table th')].map((t) => t.textContent.trim());
});
assert.ok(heads.includes('Against us'), 'data tables use "Against us" instead of "Negative"');
assert.ok(!heads.includes('Negative') && !heads.includes('Neg'), `no "Negative" table header (got ${heads.join(',')})`);

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('TRENDS-WORDING OK — charts, legend, rows and data tables read "against us / in our favour"; Vodafone-only KPI keeps the plain word');
