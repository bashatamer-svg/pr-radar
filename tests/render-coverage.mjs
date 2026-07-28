// Coverage outlets: linked ones LOOK clickable (red + ↗), URL-less stay plain.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [{
  id: 1, brand: 'e&', headline: 'e& She Blooms programme', summary: 's', sentiment: 'positive',
  importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, author: null, source: 'التعمير',
  instances: [
    { outlet: 'التعمير', author: null, url: 'https://tameer.example/a' },
    { outlet: 'سي نيوز', author: null, url: 'https://cnews.example/b' },
    { outlet: 'جريدة المال', author: null, url: '' },   // no URL → plain text
  ],
}];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8927, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8927/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 4000 });
await page.click('.cov summary');   // expand Coverage
await page.waitForTimeout(150);

const links = await page.$$eval('.cov .row a', (els) => els.map((el) => ({
  text: el.textContent, color: getComputedStyle(el).color, after: getComputedStyle(el, '::after').content,
})));
assert.strictEqual(links.length, 2, 'two linked outlets');
for (const l of links) {
  assert.strictEqual(l.color, 'rgb(230, 0, 0)', `linked outlet is red (got ${l.color})`);
  assert.ok(/↗/.test(l.after), `linked outlet carries the ↗ affordance (got ${l.after})`);
}
const plain = await page.$$eval('.cov .row span', (els) => els.map((el) => el.textContent));
assert.ok(plain.some((t) => /جريدة المال/.test(t)), 'URL-less outlet stays plain text');
const covShot = await page.$('.cov');
await covShot.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'coverage-links.png' });
await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('COVERAGE OK — linked outlets render red with ↗, URL-less outlet stays plain; screenshot saved');
