// Guide page: new sections present, renders clean at phone + desktop width.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const server = createServer((req, res) => {
  try { const b = readFileSync(new URL('..', import.meta.url).pathname + '/public' + (req.url === '/guide' ? '/guide.html' : req.url)); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8923, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const w of [390, 900]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:8923/guide', { waitUntil: 'load' });
  const text = await page.evaluate(() => document.body.textContent);
  assert.ok(/every 30 minutes/.test(text), 'ingest cadence mentioned');
  assert.ok(/newsroom/.test(text), 'desk byline explained');
  assert.ok(/tap to update/.test(text), 'auto-refresh pill explained');
  assert.ok(/Everything is clickable/.test(text), 'clickable Trends explained');
  assert.ok(/emailed the moment it lands/.test(text), 'urgent alerts explained');
  assert.ok(/any date range/.test(text) && /Word/.test(text), 'Reports section explained');
  assert.ok(/sector-wide mobile-market news/.test(text), 'market-sector scope explained');
  assert.ok(/every Vodafone mention including regulatory/.test(text), 'Vodafone regulatory exception explained');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal overflow at ${w}px (got ${overflow})`);
  assert.strictEqual(errs.length, 0, 'no page errors: ' + errs.join('; '));
  await page.close();
}
await browser.close(); server.close();
console.log('GUIDE OK — all new sections present, renders clean at 390px + 900px, no overflow, no errors');
