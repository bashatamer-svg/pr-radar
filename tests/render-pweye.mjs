// In-field show-password eye toggles on the login + change-password pages:
// each eye reveals ONLY its own field, swaps icon/aria, and toggles back.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('../public', import.meta.url).pathname;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"viewer","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/login' ? '/login.html' : u.pathname === '/account' ? '/account.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8931, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// ── login page ──
const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push('login:' + e.message));
await page.goto('http://localhost:8931/login', { waitUntil: 'networkidle' });
await page.fill('#password', 'hunter22');
assert.strictEqual(await page.getAttribute('#password', 'type'), 'password', 'starts masked');
await page.click('.eye[data-for="password"]');
assert.strictEqual(await page.getAttribute('#password', 'type'), 'text', 'eye reveals the password');
assert.strictEqual(await page.textContent('.eye[data-for="password"]'), '🙈', 'icon swaps to hide');
assert.strictEqual(await page.getAttribute('.eye[data-for="password"]', 'aria-pressed'), 'true', 'aria-pressed set');
await page.click('.eye[data-for="password"]');
assert.strictEqual(await page.getAttribute('#password', 'type'), 'password', 'second tap re-masks');
// signup mode: confirm field has its OWN independent eye
await page.click('#tabSignup');
await page.click('.eye[data-for="confirm"]');
assert.strictEqual(await page.getAttribute('#confirm', 'type'), 'text', 'confirm eye reveals confirm');
assert.strictEqual(await page.getAttribute('#password', 'type'), 'password', 'password field unaffected (per-field toggle)');
// request-access mode still hides the whole password block (wrapper, incl. the eye)
await page.click('#tabRequest');
assert.ok(await page.$eval('#pwWrap', (el) => el.style.display === 'none'), 'request mode hides the password wrapper');
await page.close();

// ── change-password page ──
const p2 = await browser.newPage({ viewport: { width: 420, height: 800 } });
p2.on('pageerror', (e) => errs.push('account:' + e.message));
await p2.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await p2.goto('http://localhost:8931/account', { waitUntil: 'networkidle' });
for (const id of ['current', 'next', 'confirm']) {
  await p2.fill(`#${id}`, 'secret123');
  await p2.click(`.eye[data-for="${id}"]`);
  assert.strictEqual(await p2.getAttribute(`#${id}`, 'type'), 'text', `${id} revealed by its eye`);
}
// each stayed independent until clicked — re-mask one, others stay revealed
await p2.click('.eye[data-for="next"]');
assert.strictEqual(await p2.getAttribute('#next', 'type'), 'password', 'next re-masked');
assert.strictEqual(await p2.getAttribute('#current', 'type'), 'text', 'current still revealed');
await p2.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'pweye-account.png' });
await p2.close();

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('PW-EYE OK — login + account: per-field reveal/re-mask, icon + aria swap, signup confirm independent, request mode hides the wrapper');
