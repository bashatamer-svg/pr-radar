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
  assert.ok(/every 15 minutes/.test(text), 'ingest cadence mentioned');
  assert.ok(/newsroom/.test(text), 'desk byline explained');
  assert.ok(/tap to update/.test(text), 'auto-refresh pill explained');
  assert.ok(/Everything is clickable/.test(text), 'clickable Trends explained');
  assert.ok(/emailed the moment it lands/.test(text), 'urgent alerts explained');
  assert.ok(/any date range/.test(text) && /Word/.test(text), 'Reports section explained');
  assert.ok(/sector-wide mobile-market news/.test(text), 'market-sector scope explained');
  assert.ok(/every Vodafone mention including regulatory/.test(text), 'Vodafone regulatory exception explained');
  // The ingest explainer must state BOTH clocks and the real numbers — this is
  // what a user reads when they ask "why isn't my story on the board yet?".
  for (const claim of ['Every 15 min', '08:00 Cairo', '30 sources', 'last 48 hours', 'Impact 2']) {
    assert.ok(text.includes(claim), `the ingest section states: ${claim}`);
  }
  // Impact is NOT audience size, however much the old "Reach" label implied it.
  // The classifier weighs how directly a story hits Vodafone as well as how far
  // it travelled, so a small outlet landing squarely on us outranks a big one
  // that barely mentions us. The guide used to say "more dots = more people
  // likely see it", which is half the definition and the wrong half.
  assert.ok(/matters to us/.test(text), 'Impact is explained as what it measures, not as audience size');
  assert.ok(/directly it hits Vodafone/.test(text), 'the directness half of the scale is stated');
  assert.ok(!/more people likely see it/.test(text), 'the audience-size-only wording is gone');
  // Each rung is named, so "why is this a 3?" is answerable from the guide.
  for (const rung of ['live reputational threat', 'real pickup', 'worth the team knowing', 'routine coverage', 'background']) {
    assert.ok(text.includes(rung), `the scale explains its levels: ${rung}`);
  }
  assert.ok(/never below 3/.test(text), 'the Vodafone-negative floor is stated');
  // The 15-minute poll is only PART of the answer — it must name the subset it
  // checks, so nobody reads it as "everything, every quarter hour".
  assert.ok(/10 brand/.test(text), 'the fast poll names the subset it actually checks');
  assert.ok(/Coverage/.test(text) && /thrown away/.test(text), 'duplicates are explained as coverage, not deletion');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal overflow at ${w}px (got ${overflow})`);
  assert.strictEqual(errs.length, 0, 'no page errors: ' + errs.join('; '));
  await page.close();
}
await browser.close(); server.close();
console.log('GUIDE OK — all sections present incl. the ingest explainer (both clocks, real source/threshold numbers), renders clean at 390px + 900px, no overflow, no errors');
