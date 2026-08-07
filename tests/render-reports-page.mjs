// /reports builder page: login gate, presets fill Cairo dates, Bearer-auth
// blob flows (PDF view opens a tab, Word downloads a .doc), and client-side
// range validation never hits the API.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('../public', import.meta.url).pathname;
const apiCalls = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"supabaseUrl":"","anonKey":""}'); return; }
  if (u.pathname === '/api/report') {
    apiCalls.push({ query: Object.fromEntries(u.searchParams), auth: req.headers.authorization || '' });
    if (u.searchParams.get('format') === 'doc') {
      res.writeHead(200, { 'content-type': 'application/msword; charset=utf-8', 'content-disposition': 'attachment; filename="x.doc"' });
      res.end('<html>doc</html>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>Coverage report</body></html>');
    }
    return;
  }
  const f = u.pathname === '/reports' ? '/reports.html' : u.pathname === '/login' ? '/login.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8933, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// ── no session → bounced to /login ──
const anon = await browser.newPage();
await anon.goto('http://localhost:8933/reports', { waitUntil: 'load' });
await anon.waitForURL(/\/login/);
await anon.close();

// ── signed in: presets, validation, both export flows ──
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8933/reports', { waitUntil: 'networkidle' });

// default preset = last 7 days, both dates filled, from ≤ to, to = Cairo today
const { from, to } = await page.evaluate(() => ({ from: document.querySelector('#from').value, to: document.querySelector('#to').value }));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to), 'both dates prefilled');
assert.ok(from < to, 'from before to');
const cairoToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
assert.strictEqual(to, cairoToday, 'preset ends today (Cairo)');
assert.strictEqual(await page.getAttribute('.chip[data-days="7"]', 'aria-pressed'), 'true', '7-day chip pressed');
// 30-day chip spans 30 Cairo days inclusive
await page.click('.chip[data-days="30"]');
const span = await page.evaluate(() => (new Date(document.querySelector('#to').value) - new Date(document.querySelector('#from').value)) / 864e5 + 1);
assert.strictEqual(span, 30, '30-day preset spans 30 days inclusive');
// daily extraction: Today chip → a single day (from = to = today)
await page.click('.chip[data-days="1"]');
const day = await page.evaluate(() => ({ from: document.querySelector('#from').value, to: document.querySelector('#to').value }));
assert.strictEqual(day.from, cairoToday, 'Today chip: from = today');
assert.strictEqual(day.to, cairoToday, 'Today chip: to = today');
// quarterly extraction: This quarter chip → from = first day of the quarter
await page.click('.chip[data-days="quarter"]');
const q = await page.evaluate(() => document.querySelector('#from').value);
const m = Number(cairoToday.slice(5, 7)), qm = m - ((m - 1) % 3);
assert.strictEqual(q, `${cairoToday.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`, 'quarter chip: from = quarter start');
assert.strictEqual(await page.evaluate(() => document.querySelector('#to').value), cairoToday, 'quarter chip: to = today');

// bad range (to < from) → inline error, API never called
await page.fill('#from', '2026-07-20');
await page.fill('#to', '2026-07-01');
await page.click('#btnPdf');
assert.ok(/before/.test(await page.textContent('#msg')), 'inline range error shown');
assert.strictEqual(apiCalls.length, 0, 'client-side validation blocks the API call');

// PDF flow: fetch carries the Bearer, report opens in a new tab (blob URL)
await page.fill('#from', '2026-07-01');
await page.fill('#to', '2026-07-07');
const popupP = page.waitForEvent('popup', { timeout: 15000 });
await page.click('#btnPdf');
const popup = await popupP;
await popup.waitForLoadState();
assert.ok((await popup.evaluate(() => document.body.textContent)).includes('Coverage report'), 'report rendered in the new tab');
assert.strictEqual(apiCalls.length, 1);
assert.deepStrictEqual(apiCalls[0].query, { from: '2026-07-01', to: '2026-07-07' }, 'PDF view passes the range');
assert.strictEqual(apiCalls[0].auth, 'Bearer x', 'session Bearer attached');
assert.ok(/new tab/.test(await page.textContent('#msg')), 'PDF guidance shown');
await popup.close();

// Word flow: same range with format=doc, triggers a .doc download
const dlP = page.waitForEvent('download', { timeout: 15000 });
await page.click('#btnDoc');
const dl = await dlP;
assert.strictEqual(dl.suggestedFilename(), 'pr-radar-report-2026-07-01-to-2026-07-07.doc', 'dated .doc filename');
assert.strictEqual(apiCalls.length, 2);
assert.strictEqual(apiCalls[1].query.format, 'doc', 'Word flow asks for format=doc');
assert.strictEqual(apiCalls[1].auth, 'Bearer x', 'session Bearer attached');
assert.ok(/Word document downloaded/.test(await page.textContent('#msg')), 'Word confirmation shown');

// no layout overflow on phones
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 1, `no horizontal overflow (got ${overflow})`);
assert.strictEqual(errs.length, 0, 'no page errors: ' + errs.join('; '));

await page.close(); await browser.close(); server.close();
console.log('REPORTS-PAGE OK — login gate, Cairo presets, inline validation, Bearer blob flows: PDF tab + .doc download');
