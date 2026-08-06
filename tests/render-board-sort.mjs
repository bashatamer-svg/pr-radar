// The board's Sort control: ◉ Impact (the original order, grouped into the three
// lanes) vs ↓ Newest (one FLAT chronological run, lanes set aside).
//
// What this pins:
//   1. Impact is the default on load — the safe order for a monitoring board.
//   2. Newest drops the lane headers entirely and orders purely by publication
//      time. Sorting *inside* the lanes was the rejected alternative: it still
//      buries the freshest story under two sections.
//   3. Newest keeps Impact as its TIE-BREAK, so equally fresh cards are not left
//      in whatever order the API happened to return them.
//   4. Sorting NEVER hides a card — the same set is on screen in both orders.
//      (It sits apart from the filter rows for exactly this reason.)
//   5. The status line names the order only when it is NOT the default.
//   6. The choice does not survive a reload — a forgotten Newest sort would
//      quietly push an Impact 5 below a trickle of fresh trivia.
//   7. The new row does not widen the document on a 390px phone. Every previous
//      control row on this board starved or panned at that width; see the flex
//      Gotchas in CLAUDE.md.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const TIE = H(1); // ids 2 and 5 are filed the same instant, on purpose

const items = [
  { id: 1, brand: 'Vodafone', headline: 'Vodafone outage hits Greater Cairo', summary: 's', sentiment: 'negative', importance: 5, category: 'network', url: 'u1', resolved_url: 'u1', published_at: H(10), instances: [] },
  { id: 2, brand: 'Vodafone', headline: 'Vodafone Cash passes three million users', summary: 's', sentiment: 'positive', importance: 3, category: 'product', url: 'u2', resolved_url: 'u2', published_at: TIE, instances: [] },
  { id: 3, brand: 'Orange', headline: 'Orange billing glitch frustrates subscribers', summary: 's', sentiment: 'negative', importance: 4, category: 'billing', url: 'u3', resolved_url: 'u3', published_at: H(5), instances: [] },
  { id: 4, brand: 'WE', headline: 'WE expands fibre rollout', summary: 's', sentiment: 'neutral', importance: 2, category: 'market', url: 'u4', resolved_url: 'u4', published_at: H(20), instances: [] },
  { id: 5, brand: 'Vodafone', headline: 'Vodafone store queue complaint goes viral', summary: 's', sentiment: 'negative', importance: 2, category: 'service', url: 'u5', resolved_url: 'u5', published_at: TIE, instances: [] },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8945, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1600 } });
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8945/?win=30', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 5000 });

const cardIds = () => page.$$eval('.card', els => els.map(e => Number(e.id.replace('item-', ''))));
const heads = () => page.$$eval('.sechead .lab', els => els.map(e => e.textContent.trim()));
const statusTxt = () => page.$eval('#status', e => e.textContent.replace(/\s+/g, ' ').trim());

// ── 1. Impact is the default, and it groups into lanes ──────────────────────
assert.strictEqual(await page.$eval('#sortRow .chip[data-sort="impact"]', e => e.getAttribute('aria-pressed')), 'true',
  'Impact is pressed on load');
assert.strictEqual(await page.$eval('#sortRow .chip[data-sort="newest"]', e => e.getAttribute('aria-pressed')), 'false',
  'Newest is not pressed on load');
assert.deepStrictEqual(await heads(), ['Needs a response', 'Wins to amplify', 'Market & noted'],
  'the default order keeps the three lane sections');
const impactOrder = await cardIds();
assert.deepStrictEqual(impactOrder, [1, 5, 2, 3, 4],
  `Impact order: lane, then Impact desc (got ${impactOrder})`);
const impactStatus = await statusTxt();
assert.ok(!/Newest/.test(impactStatus), `the default order is not announced (got "${impactStatus}")`);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'board-sort-impact.png', fullPage: true });

// ── 2 & 3. Newest is flat, chronological, Impact as tie-break ───────────────
await page.click('#sortRow .chip[data-sort="newest"]');
await page.waitForTimeout(150);
assert.deepStrictEqual(await heads(), ['↓ Newest first'],
  'Newest replaces the three lane headers with a single one — the lanes are set aside, not re-sorted inside');
const newestOrder = await cardIds();
assert.deepStrictEqual(newestOrder, [2, 5, 3, 1, 4],
  `Newest order is pure publication time, with Impact breaking the 2-vs-5 tie (got ${newestOrder})`);

// The lane TINT has to survive the loss of the lane headings, or a flat list
// throws away the one signal that says "this one is a fire".
assert.ok(await page.$eval('#item-1', e => e.classList.contains('negative')), 'a needs-response card is still red-washed in the flat list');
assert.ok(await page.$eval('#item-2', e => e.classList.contains('positive')), 'a win still carries its own border in the flat list');

// ── 4. Sorting hides nothing ────────────────────────────────────────────────
assert.deepStrictEqual([...newestOrder].sort(), [...impactOrder].sort(),
  'both orders show exactly the same cards — Sort re-orders, it never filters');

// ── 5. The non-default order says so ────────────────────────────────────────
const newestStatus = await statusTxt();
assert.ok(/Newest first/.test(newestStatus), `the status line names the non-default order (got "${newestStatus}")`);
assert.ok(/5 shown/.test(newestStatus), `the count is unchanged by sorting (got "${newestStatus}")`);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'board-sort-newest.png', fullPage: true });

// ── back to Impact restores the lanes ───────────────────────────────────────
await page.click('#sortRow .chip[data-sort="impact"]');
await page.waitForTimeout(150);
assert.deepStrictEqual(await heads(), ['Needs a response', 'Wins to amplify', 'Market & noted'],
  'switching back restores the lane sections');
assert.deepStrictEqual(await cardIds(), impactOrder, 'switching back restores the original order');

// Sort composes with the lane filter rather than fighting it: filter to the
// needs-response lane, then flip to Newest, and only those cards are ordered.
await page.click('#sentRow .chip[data-v="negative"]');
await page.click('#sortRow .chip[data-sort="newest"]');
await page.waitForTimeout(150);
assert.deepStrictEqual(await cardIds(), [5, 1], 'Newest applies within an active filter, freshest first');
await page.click('#sentRow .chip[data-v="all"]');
await page.waitForTimeout(120);

// ── 6. The choice does not survive a reload ─────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 5000 });
assert.strictEqual(await page.$eval('#sortRow .chip[data-sort="impact"]', e => e.getAttribute('aria-pressed')), 'true',
  'a reload returns to Impact — the sort is deliberately not remembered');
assert.deepStrictEqual(await heads(), ['Needs a response', 'Wins to amplify', 'Market & noted'],
  'a reload returns to the lane sections');

// ── 7. The new row on a 390px phone ─────────────────────────────────────────
// Every control row on this board has starved or panned the page at this width
// at some point. .frow scrolls internally by design; what must NOT happen is
// the document itself growing wider than the viewport.
await page.setViewportSize({ width: 390, height: 1400 });
await page.waitForTimeout(150);
const overflow390 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow390 <= 1, `the sort row must not widen the document at 390px (overflowed by ${overflow390}px)`);
// Both chips keep their designed size — a shrunken chip is the failure mode the
// card-footer and admin-row Gotchas describe.
const chipBoxes = await page.$$eval('#sortRow .chip', els => els.map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
assert.strictEqual(chipBoxes.length, 2, 'two sort chips are rendered');
for (const b of chipBoxes) {
  assert.ok(b.w >= 60, `a sort chip keeps a tappable width (got ${Math.round(b.w)}px)`);
  assert.ok(b.h >= 28, `a sort chip keeps a tappable height (got ${Math.round(b.h)}px)`);
}
// At 390 the whole row fits without needing the sideways scroll the busier rows use.
const rowFits = await page.$eval('#sortRow', e => e.scrollWidth - e.clientWidth);
assert.ok(rowFits <= 1, `two chips and a label fit a phone without scrolling (overflowed by ${rowFits}px)`);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'board-sort-390.png', fullPage: true });

await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('BOARD SORT TEST PASSED — Impact is the default and keeps the lanes; Newest is one flat chronological run with Impact as tie-break; sorting hides nothing, is announced, is not remembered across a reload, and fits a 390px phone');
