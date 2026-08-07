// Task 15 (revised) — skeleton loaders + shareable snapshot. Dark mode removed.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const SCR = new URL('./out', import.meta.url).pathname;
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'انقطاع خدمة فودافون كاش Vodafone Cash يثير غضب المستخدمين بعد تحديث 5G!', summary: 'تفاصيل الحادث.', sentiment: 'negative', importance: 5, category: 'vodafone_cash', country: 'Egypt', author: 'محمد علي', url: 'u', resolved_url: 'u', confidence: 0.9, published_at: now, pr_angle: 'Read · x\nAudience · y\nAction · Prepare a holding line and brief the comms lead', instances: [{ outlet: 'Youm7', url: 'u' }, { outlet: 'Masrawy', url: 'u2' }] },
  { id: 2, brand: 'Orange', headline: 'Orange launches new campaign', summary: 's', sentiment: 'positive', importance: 2, category: 'campaign', url: 'u', resolved_url: 'u', confidence: 0.8, published_at: now, instances: [] },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); }, 350); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8901, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// board loads light regardless of OS preference (dark mode removed)
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, colorScheme: 'dark' });
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8901/?t=tok', { waitUntil: 'domcontentloaded' });

// skeleton appears before data (API delayed ~350ms), then is replaced by cards
await page.waitForSelector('.skel', { timeout: 2000 });
await page.waitForSelector('.card', { timeout: 4000 });
assert.ok(!(await page.$('.skel')), 'skeleton replaced by cards once loaded');

// no theme machinery left, and no dark theme applied even with dark OS
assert.ok(!(await page.$('#themeBtn')), 'no theme toggle button');
assert.strictEqual(await page.getAttribute('html', 'data-theme'), null, 'no data-theme attribute set');
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
assert.strictEqual(bg, 'rgb(241, 242, 245)', 'body stays light (#f1f2f5) under dark OS');
await page.screenshot({ path: SCR + '/board-light.png', fullPage: true });

// snapshot: click card share → modal shows a PNG blob
await page.click('#item-1 .fb.share');
await page.waitForSelector('#snap.on', { timeout: 3000 });
await page.waitForTimeout(300);
const imgOk = await page.evaluate(() => { const im = document.getElementById('snapImg'); return im && im.src.startsWith('blob:') && im.naturalWidth > 100; });
assert.ok(imgOk, 'card snapshot produced a PNG blob and rendered');
const snapData = await page.evaluate(() => { const im = document.getElementById('snapImg'); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); return c.toDataURL('image/png'); });
writeFileSync(SCR + '/snapshot-card.png', Buffer.from(snapData.split(',')[1], 'base64'));
await page.click('#snapCl');
assert.ok(!(await page.$('#snap.on')), 'snapshot modal closes');

// pulse snapshot
await page.click('#pulse .shbtn');
await page.waitForSelector('#snap.on', { timeout: 3000 });
await page.waitForTimeout(300);
const pulseSnap = await page.evaluate(() => { const im = document.getElementById('snapImg'); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); return c.toDataURL('image/png'); });
writeFileSync(SCR + '/snapshot-pulse.png', Buffer.from(pulseSnap.split(',')[1], 'base64'));

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 15 TESTS PASSED — skeleton→cards, light-only (no theme machinery), card+pulse PNG snapshots');
