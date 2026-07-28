// Live auto-refresh: an open board picks up newly-ingested stories without a
// manual reload — applying in place when the reader is at the top, and offering
// a "N new — tap to update" pill when they're scrolled down. Never lies about
// the count (only new cards the active filter would show).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const mk = (id, headline, extra = {}) => ({ id, brand: 'Vodafone', headline, summary: 's', sentiment: 'neutral', importance: 3, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [{ outlet: 'Youm7', author: 'A', url: 'u' }], ...extra });

// Server state the test mutates to simulate a fresh ingest.
let serverItems = Array.from({ length: 8 }, (_, i) => mk(i + 1, `Story ${i + 1}`));

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/items') return j(serverItems);
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'me') return j({ email: 'a@b.com', role: 'admin', kind: 'user' });
    return j({ supabaseUrl: '', anonKey: '' });
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8917, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const page = await browser.newPage({ viewport: { width: 720, height: 760 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8917/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 4000 });
assert.strictEqual((await page.$$('.card')).length, 8, 'board loaded 8 cards');
assert.ok(await page.$eval('#newPill', el => el.hidden), 'pill hidden initially');

// ── reader AT THE TOP: a new story refreshes in place, no pill ──
await page.evaluate(() => window.scrollTo(0, 0));
serverItems = [mk(99, 'Breaking — Vodafone Cash outage'), ...serverItems];
await page.evaluate(() => checkNew());
await page.waitForTimeout(150);
assert.ok(await page.$('#item-99'), 'new story applied in place while at the top');
assert.strictEqual((await page.$$('.card')).length, 9, 'card count grew to 9');
assert.ok(await page.$eval('#newPill', el => el.hidden), 'no pill when refreshed in place');

// ── reader SCROLLED DOWN: a new story surfaces the pill, not a yank ──
await page.evaluate(() => window.scrollTo(0, 600));
const scrolled = await page.evaluate(() => window.scrollY);
assert.ok(scrolled >= 120, `page scrolled down (scrollY=${scrolled})`);
serverItems = [mk(100, 'Breaking — second new story'), ...serverItems];
await page.evaluate(() => checkNew());
await page.waitForTimeout(150);
assert.ok(!(await page.$('#item-100')), 'new story NOT auto-inserted while reading down the list');
assert.ok(!(await page.$eval('#newPill', el => el.hidden)), 'pill shown while scrolled down');
assert.ok(/1 new story/.test(await page.$eval('#newPill', el => el.textContent)), 'pill names the new-story count');

// tap the pill → applies + scrolls up
await page.click('#newPill');
await page.waitForTimeout(200);
assert.ok(await page.$('#item-100', el => el), 'tapping the pill applied the new story');
assert.ok(await page.$eval('#newPill', el => el.hidden), 'pill hidden after tapping');
assert.strictEqual((await page.$$('.card')).length, 10, 'card count grew to 10');

// ── new item OUTSIDE the active filter → no pill (count never lies) ──
await page.evaluate(() => { window.scrollTo(0, 600); fSent = 'positive'; render(); });
await page.waitForTimeout(100);
serverItems = [mk(101, 'A neutral story', { sentiment: 'neutral' }), ...serverItems];
await page.evaluate(() => checkNew());
await page.waitForTimeout(150);
assert.ok(await page.$eval('#newPill', el => el.hidden), 'no pill for a new item the active filter would hide');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('AUTO-REFRESH OK — at top: applies in place; scrolled down: "N new" pill → tap applies; filtered-out new items raise no pill; no page errors');
