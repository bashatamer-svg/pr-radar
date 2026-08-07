// Task 13 — confidence pip + low-confidence filter.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'High confidence story', summary: 's', sentiment: 'negative', importance: 4, category: 'network', url: 'u', resolved_url: 'u', confidence: 0.95, published_at: now, instances: [] },
  { id: 2, brand: 'Orange', headline: 'Low confidence story', summary: 's', sentiment: 'neutral', importance: 2, category: 'campaign', url: 'u', resolved_url: 'u', confidence: 0.3, published_at: now, instances: [] },
  { id: 3, brand: 'WE', headline: 'Medium confidence story', summary: 's', sentiment: 'positive', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', confidence: 0.6, published_at: now, instances: [] },
  { id: 4, brand: 'Vodafone', headline: 'No confidence field', summary: 's', sentiment: 'neutral', importance: 2, category: 'other', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(items)); }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8899, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8899/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// pip present on items with confidence, absent on the one without
assert.ok(await page.$('#item-1 .cpip'), 'pip on high-confidence card');
assert.ok(await page.$('#item-2 .conf.low'), 'low-confidence card pip has .low (amber)');
assert.ok(!(await page.$('#item-4 .cpip')), 'no pip when confidence missing');
// tiers: high=3 on-bars, low=1 on-bar
const onBars = (sel) => page.$$eval(sel + ' .cpip i.on', (els) => els.length);
assert.strictEqual(await onBars('#item-1'), 3, 'high confidence → 3 filled bars');
assert.strictEqual(await onBars('#item-2'), 1, 'low confidence → 1 filled bar');
assert.strictEqual(await onBars('#item-3'), 2, 'medium → 2 filled bars');
// tooltip carries the percentage
assert.ok(/62%|60%/.test(await page.$eval('#item-3 .cplab', el => el.textContent)), 'confidence % shown in the label');
assert.ok(/low, double-check/.test(await page.getAttribute('#item-2 .conf', 'title')), 'low tooltip warns');

// Low-conf filter → only item-2 shows
await page.click('.chip[data-lowconf]');
await page.waitForTimeout(200);
const shown = await page.$$eval('.card', (els) => els.map((e) => e.id));
assert.deepStrictEqual(shown, ['item-2'], `only low-conf shown: ${shown}`);
assert.strictEqual(await page.getAttribute('.chip[data-lowconf]', 'aria-pressed'), 'true');
// toggle off → all back
await page.click('.chip[data-lowconf]');
await page.waitForTimeout(200);
assert.strictEqual((await page.$$('.card')).length, 4, 'all cards back after toggle off');

await page.click('.chip[data-lowconf]');   // re-enable for the screenshot
await page.waitForTimeout(150);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'conf-board.png', fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 13 TESTS PASSED — pip tiers/amber/tooltip + low-conf filter');
