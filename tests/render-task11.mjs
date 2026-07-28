// Task 11 — pin/hide control + Pinned filter on the board.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const win = [
  { id: 1, brand: 'Vodafone', headline: 'Normal story', summary: 's', sentiment: 'negative', importance: 4, category: 'network', url: 'u', resolved_url: 'u', team_share: null, published_at: now, instances: [] },
  { id: 2, brand: 'Orange', headline: 'Server-pinned story', summary: 's', sentiment: 'neutral', importance: 2, category: 'campaign', url: 'u', resolved_url: 'u', team_share: true, published_at: now, instances: [] },
  { id: 3, brand: 'WE', headline: 'Hidden story', summary: 's', sentiment: 'positive', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', team_share: false, published_at: now, instances: [] },
];
const older = { id: 99, brand: 'Vodafone', headline: 'Old pinned story', summary: 's', sentiment: 'negative', importance: 3, category: 'pricing', url: 'u', resolved_url: 'u', team_share: true, published_at: new Date(Date.now() - 60 * 864e5).toISOString(), instances: [] };

const patches = [];
let idsRequested = null;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') {
    if (req.method === 'PATCH') { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { patches.push(JSON.parse(b || '{}')); res.writeHead(204); res.end(); }); return; }
    if (u.searchParams.get('ids')) { idsRequested = u.searchParams.get('ids'); const ids = idsRequested.split(',').map(Number); const all = [...win, older].filter((i) => ids.includes(i.id)); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(all)); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(win));
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const body = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8897, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// seed an OLDER pinned id (as if pinned earlier, now out of window)
await page.addInitScript(() => localStorage.setItem('pr_pinned', JSON.stringify([99])));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8897/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// server-pinned + hidden classes rendered
assert.ok(await page.$('#item-2.pinned'), 'server-pinned card has .pinned');
assert.ok(await page.$('#item-2 .pinmark.pin'), 'pinned marker shown');
assert.ok(await page.$('#item-3.hidden'), 'hidden card has .hidden');
assert.strictEqual(await page.getAttribute('#item-2 .fb.pin', 'aria-pressed'), 'true', 'pin button pressed on server-pinned');

// pin a normal card → PATCH team_share:true, class flips, marker appears
await page.click('#item-1 .fb.pin');
await page.waitForTimeout(150);
assert.ok(await page.$('#item-1.pinned'), 'item-1 became pinned');
assert.ok(await page.$('#item-1 .pinmark.pin'), 'item-1 pin marker appeared');
assert.ok(patches.some((p) => p.id === 1 && p.team_share === true), 'PATCH team_share:true sent for item-1');
// localStorage updated
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pr_pinned')));
assert.ok(stored.includes(1) && stored.includes(2) && stored.includes(99), `pinned set synced: ${stored}`);

// hide another card → PATCH team_share:false
await page.click('#item-1 .fb.hide');   // item-1 was pinned; hide should flip to hidden
await page.waitForTimeout(150);
assert.ok(await page.$('#item-1.hidden'), 'item-1 flipped to hidden');
assert.ok(patches.some((p) => p.id === 1 && p.team_share === false), 'PATCH team_share:false sent');
// re-pin item-1 for the filter test
await page.click('#item-1 .fb.pin');
await page.waitForTimeout(150);

// activate Pinned filter → fetches older pin by id, shows only pinned
await page.click('.chip[data-pin]');
await page.waitForTimeout(400);
assert.strictEqual(idsRequested, '99', `older pin fetched by id (got ${idsRequested})`);
const shownIds = await page.$$eval('.card', (els) => els.map((e) => e.id));
assert.ok(shownIds.includes('item-1') && shownIds.includes('item-2') && shownIds.includes('item-99'), `pinned shown: ${shownIds}`);
assert.ok(!shownIds.includes('item-3'), 'hidden (non-pinned) card excluded under Pinned filter');
assert.strictEqual(await page.getAttribute('.chip[data-pin]', 'aria-pressed'), 'true', 'Pinned chip active');

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'pin-board.png', fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 11 TESTS PASSED — pin/hide PATCH + markers + Pinned filter (incl. by-id fetch of old pin)');
