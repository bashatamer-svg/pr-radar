// Trends short windows: 24 hours and 48 hours.
//
// /api/stats already accepted days=1|2 (it clamps 1..90) and itemsForStats cuts
// at Date.now() - N*864e5 — a ROLLING window, not "since Cairo midnight" — so
// these two chips are honestly named in hours. Three things this pins:
//
//   1. The chips exist, ask for the right window, and use the SAME words the
//      board already uses for the same two windows.
//   2. Nothing on the page says "last 1 days". Eight places name the window and
//      they all read from one helper.
//   3. The per-day charts admit their end buckets are PARTIAL at these widths.
//      The rolling window is bucketed into Cairo calendar days, so a 24h window
//      straddling midnight draws two part-day bars — and a half-day bar read as
//      a whole day is a wrong conclusion, not a rough one.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const series = (m, n) => ({ mentions: m, negatives: n });
// Two Cairo days, which is what a rolling 24h window straddling midnight yields.
const stats = (days) => ({
  meta: { days, generatedAt: new Date().toISOString(), items: 6 },
  days: ['2026-08-07', '2026-08-08'],
  sov: {
    Vodafone: series([2, 1], [1, 1]), Orange: series([1, 0], [0, 0]),
    WE: series([0, 1], [0, 0]), 'e&': series([1, 0], [1, 0]), Market: series([0, 0], [0, 0]),
  },
  sentimentByBrand: { Vodafone: { negative: 2, neutral: 1, positive: 0, total: 3 } },
  categories: [{ category: 'corporate', total: 3, negative: 2, vodNeg: 1, series: [2, 1] }],
  narratives: [],
  outlets: [{ outlet: 'Youm7', mentions: 3, negative: 2, neutral: 1, positive: 0, vodNeg: 1, series: [2, 1] }],
  authors: [{ author: 'Sara', outlets: ['Youm7'], mentions: 3, negative: 2, neutral: 1, positive: 0, vodNeg: 1, series: [2, 1] }],
  totals: { items: 6, negatives: 3, positives: 1, neutrals: 2, vodafone: { mentions: 3, negatives: 2 }, distinctOutlets: 2, distinctAuthors: 2, itemsWithByline: 3 },
});

const asked = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') {
    const d = Number(u.searchParams.get('days')) || 30;
    if (u.searchParams.get('view') !== 'narratives') asked.push(d);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u.searchParams.get('view') === 'narratives' ? { narratives: [] } : stats(d)));
    return;
  }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8947, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8947/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('.cardc', { timeout: 5000 });

const chips = () => page.$$eval('#winRow .chip[data-v]', (els) => els.map((e) => ({ v: e.dataset.v, label: e.textContent.trim(), on: e.getAttribute('aria-pressed') === 'true' })));

// ── 1. the chips exist, in ascending order, and are labelled like the board ──
{
  const c = await chips();
  assert.deepStrictEqual(c.map((x) => x.v), ['1', '2', '7', '14', '30', '60', '90'], 'short windows lead the row');
  assert.strictEqual(c[0].label, '24 hours', 'the 1-day chip is named in hours');
  assert.strictEqual(c[1].label, '48 hours', 'so is the 2-day chip');

  // The board offers the same two windows. Two surfaces naming one window
  // differently is exactly the drift the shared-vocabulary rule exists to stop.
  const board = readFileSync(DIR + '/index.html', 'utf8');
  const m = board.match(/const wopts=\[([^\]]*\])\s*\]/) || board.match(/const wopts=(\[.*?\]\]);/s);
  assert.ok(m, 'board defines its window chips');
  for (const [v, label] of [['1', '24 hours'], ['2', '48 hours']]) {
    assert.ok(m[0].includes(`['${v}','${label}']`),
      `board labels win=${v} as "${label}" — Trends must match (board row: ${m[0].slice(0, 120)})`);
  }
}

// ── 2. picking 24 hours asks for days=1 and never says "1 days" ──────────────
{
  asked.length = 0;
  await page.click('#winRow .chip[data-v="1"]');
  await page.waitForFunction(() => !document.body.innerText.includes('Loading'), { timeout: 5000 });
  await page.waitForTimeout(150);
  assert.ok(asked.includes(1), `the 24-hour chip requests days=1 (asked ${JSON.stringify(asked)})`);

  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!/\b1 days?\b(?! ago)/.test(text.replace(/24 hours/g, '')), `no "last 1 days" anywhere (got: ${(text.match(/last [^\n·]*/g) || []).join(' | ')})`);
  assert.ok(/last 24 hours/.test(text), 'the window is stated in hours');
  // The KPI tile uses the short form; "last 1d" would be the same bug.
  assert.ok(/last 24h/.test(text) && !/last 1d\b/.test(text), 'the KPI tile short form is 24h, not 1d');

  // 3. …and the per-day charts admit their end buckets are partial.
  const subs = await page.$$eval('#c-sov .cs, #c-neg .cs', (els) => els.map((e) => e.textContent.trim()));
  for (const s of subs) assert.ok(/end days are partial/.test(s), `a per-day chart must flag partial buckets at 24h (got "${s}")`);
  // The aggregate card is unaffected — it does not bucket by day at all.
  const sent = await page.$eval('#c-sent .cs', (e) => e.textContent.trim());
  assert.ok(!/partial/.test(sent), `the non-time-series card must not claim partial buckets (got "${sent}")`);

  // Deep links stay on the board's matching window rather than snapping to 7.
  const href = await page.$eval('a.kpi', (a) => a.getAttribute('href'));
  assert.ok(/win=1\b/.test(href), `KPI deep link carries win=1 (got ${href})`);
}

// ── 48 hours behaves the same, with its own wording ──────────────────────────
{
  asked.length = 0;
  await page.click('#winRow .chip[data-v="2"]');
  await page.waitForFunction(() => document.body.innerText.includes('last 48 hours'), { timeout: 5000 });
  assert.ok(asked.includes(2), `the 48-hour chip requests days=2 (asked ${JSON.stringify(asked)})`);
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!/\b2 days\b/.test(text.replace(/48 hours/g, '')), 'no "last 2 days" phrasing');
  assert.ok(/last 48h/.test(text), 'KPI tile short form is 48h');
  const href = await page.$eval('a.kpi', (a) => a.getAttribute('href'));
  assert.ok(/win=2\b/.test(href), `KPI deep link carries win=2 (got ${href})`);
}

// ── a long window is untouched: days, and no partial-bucket caveat ───────────
{
  await page.click('#winRow .chip[data-v="30"]');
  await page.waitForFunction(() => document.body.innerText.includes('last 30 days'), { timeout: 5000 });
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(/last 30 days/.test(text), 'a month still reads in days');
  assert.ok(/last 30d/.test(text), 'and the tile short form is 30d');
  const subs = await page.$$eval('#c-sov .cs, #c-neg .cs', (els) => els.map((e) => e.textContent.trim()));
  for (const s of subs) assert.ok(!/partial/.test(s), `a 30-day window has whole buckets and must not say otherwise (got "${s}")`);
  // The chip the reader picked is the one that reads as pressed.
  const on = (await chips()).filter((c) => c.on).map((c) => c.v);
  assert.deepStrictEqual(on, ['30'], 'exactly one chip is pressed, and it is the chosen one');
}

// ── the export filename names the window in hours, not "1d" ──────────────────
{
  await page.click('#winRow .chip[data-v="1"]');
  await page.waitForFunction(() => document.body.innerText.includes('last 24 hours'), { timeout: 5000 });
  const name = await page.evaluate(() => {
    let captured = null;
    const real = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) captured = this.download; else real.call(this); };
    document.querySelector('#c-sov .xp[data-fmt="xls"]').click();
    HTMLAnchorElement.prototype.click = real;
    return captured;
  });
  assert.ok(name && /-24h-/.test(name), `the export filename carries 24h, not 1d (got ${name})`);
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('TRENDS-WINDOWS OK — 24h/48h chips request days=1|2, are worded like the board, never render "last 1 days", flag the per-day charts\' partial end buckets at those widths only, deep-link to the matching board window and name the export file in hours');
