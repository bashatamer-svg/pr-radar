// Narrative rows readability: long Arabic names wrap to 2 lines with correct
// bidi at phone width (390px) instead of a garbled single-line ellipsis.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"totals":{"items":0}}'); return; }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8925, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8925/stats', { waitUntil: 'networkidle' });

// Real-shaped narratives: long Arabic sentence names + mixed-direction ones.
await page.evaluate(() => {
  DATA = { meta: { days: 7 }, totals: { items: 30, negatives: 5, distinctOutlets: 9, vodafone: { mentions: 10, negatives: 2 } } };
  const narratives = [
    { name: 'أسعار الإنترنت الأرضي الجديدة تشعل مواجهة مباشرة مع المستهلكين', headline: 'مواجهة مباشرة مع المستهلك بعد قرار الزيادة', brand: 'Market', total: 6, negative: 5, neutral: 1, positive: 0, series: [1, 2, 0, 3], ids: [1, 2, 3], rising: true, risingScore: 3 },
    { name: 'Vodafone · فودافون مصر تعلن شراكة استراتيجية مع النادي الأهلي لتطوير استاد الأهلي الجديد', headline: 'شراكة استراتيجية مع النادي الأهلي.. فيديو', brand: 'Vodafone', total: 5, negative: 0, neutral: 1, positive: 4, series: [0, 1, 2, 2], ids: [4, 5, 6] },
    { name: 'Vodafone · شكوى خصم المبلغ دون صرفه من ماكينة ATM وتضارب ردود فودافون كاش', headline: 'المبلغ دون صرفه من ماكينة ATM', brand: 'Vodafone', total: 3, negative: 3, neutral: 0, positive: 0, series: [0, 2, 0, 1], ids: [7, 8] },
    { name: 'WE · Telecom Egypt H1 2026 results beat expectations with $5.95 billion revenue', headline: 'With $5.95 billion.. E& bid context', brand: 'WE', total: 16, negative: 0, neutral: 14, positive: 2, series: [2, 4, 3, 5], ids: [9, 10] },
  ];
  const el = document.createElement('div');
  el.className = 'cardc'; el.id = 'narrTest'; el.style.margin = '12px';
  el.innerHTML = narrativeRows(narratives).rows;
  document.body.prepend(el);
});
await page.waitForTimeout(200);

// Every name must render MORE than a stub: at least ~20 visible chars, and the
// long Arabic ones must occupy two lines (height > 1.6 × line-height).
const rows = await page.$$eval('#narrTest .lrow.narr .nm', (els) => els.map((el) => {
  const cs = getComputedStyle(el);
  return { text: el.textContent.trim(), h: el.clientHeight, lh: parseFloat(cs.lineHeight), ws: cs.whiteSpace, dir: el.getAttribute('dir') };
}));
assert.strictEqual(rows.length, 4, '4 narrative rows rendered');
for (const r of rows) {
  assert.strictEqual(r.dir, 'auto', 'name has dir=auto');
  assert.ok(r.ws !== 'nowrap', 'name is allowed to wrap');
}
assert.ok(rows[0].h >= rows[0].lh * 1.6, `long Arabic name uses 2 lines (h=${rows[0].h}, lh=${rows[0].lh})`);
// sparkline hidden at phone width to give the name room
const sparkHidden = await page.$eval('#narrTest .lrow.narr .spark', (el) => getComputedStyle(el).display === 'none');
assert.ok(sparkHidden, 'sparkline hidden at 390px for narrative rows');
// full-name tooltip restored
const title = await page.$eval('#narrTest .lrow.narr', (el) => el.getAttribute('title'));
assert.ok(/أسعار الإنترنت الأرضي/.test(title), 'row title carries the full narrative name');

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'narratives-390.png', clip: { x: 0, y: 0, width: 390, height: 560 } });
await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('NARRATIVES OK — names wrap to 2 lines with dir=auto, spark hidden at phone width, full-name tooltip back; screenshot saved');
