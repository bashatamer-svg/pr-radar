// Task 16 frontend — login redirect, role-gated controls, login form.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'Vodafone Cash outage angers users', summary: 's', sentiment: 'negative', importance: 5, category: 'vodafone_cash', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
];
let posted = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const auth = req.headers.authorization || '';
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/auth') {
    const view = u.searchParams.get('view');
    if (req.method === 'POST') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const p = JSON.parse(b || '{}'); posted.push(p);
      if (p.mode === 'change_password') { if (p.current === 'secret123') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } else { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"your current password is incorrect"}'); } return; }
      if (p.mode === 'request') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      if (p.password === 'secret123' || p.mode === 'signup') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, access_token: 'viewer-token', refresh_token: 'r', role: 'viewer' })); } else { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"wrong email or password"}'); } }); return; }
    if (view === 'config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"supabaseUrl":"","anonKey":""}'); return; }
    if (view === 'me') {
      let role = null, email = null;
      if (/admin-token/.test(auth)) { role = 'admin'; email = 'admin@vodafone.com'; }
      else if (/viewer-token/.test(auth)) { role = 'viewer'; email = 'viewer@vodafone.com'; }
      if (!role) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ email, role, kind: 'user' })); return;
    }
  }
  const f = u.pathname === '/' ? '/index.html' : (u.pathname === '/login' ? '/login.html' : (u.pathname === '/account' ? '/account.html' : u.pathname));
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8903, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];

// 1) No auth → redirect to /login
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('board:' + e.message));
  await page.goto('http://localhost:8903/', { waitUntil: 'networkidle' });
  assert.ok(/\/login$/.test(page.url()), 'unauthenticated board redirects to /login, got ' + page.url());
  await page.close();
}

// 2) Viewer session → board loads, write controls hidden, account shows email
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on('pageerror', (e) => errs.push('viewer:' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'viewer-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8903/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 4000 });
  assert.strictEqual(await page.getAttribute('body', 'data-role'), 'viewer', 'body tagged viewer');
  assert.ok(await page.$eval('#account .who', el => /viewer@vodafone/.test(el.textContent)), 'account shows viewer email');
  const pinShown = await page.$eval('#item-1 .fb.pin', el => getComputedStyle(el).display !== 'none').catch(() => true);
  assert.strictEqual(pinShown, false, 'viewer: pin control is hidden');
  const upShown = await page.$eval('#item-1 .fb.up', el => getComputedStyle(el).display !== 'none').catch(() => true);
  assert.strictEqual(upShown, false, 'viewer: vote control is hidden');
  // copy-brief (read-only) stays available
  assert.ok(await page.$('#item-1 .btn.copy'), 'viewer keeps read-only copy brief');
  // viewer sees NO admin link, but does see the change-password link
  assert.ok(!(await page.$('#account a[href="/admin"]')), 'viewer: no admin link');
  assert.ok(await page.$('#account a[href="/account"]'), 'viewer: has change-password link');
  await page.close();
}

// 3) Admin session → write controls visible
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on('pageerror', (e) => errs.push('admin:' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8903/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 4000 });
  assert.strictEqual(await page.getAttribute('body', 'data-role'), 'admin', 'body tagged admin');
  const pinShown = await page.$eval('#item-1 .fb.pin', el => getComputedStyle(el).display !== 'none');
  assert.ok(pinShown, 'admin: pin control visible');
  assert.ok(await page.$('#account a[href="/admin"]'), 'admin: admin-panel link is present');
  await page.close();
}

// 4) Password sign-in: wrong password errors, correct password lands on the board
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on('pageerror', (e) => errs.push('login:' + e.message));
  await page.goto('http://localhost:8903/login', { waitUntil: 'networkidle' });
  // default mode is sign in
  assert.strictEqual(await page.getAttribute('#btn', 'aria-pressed').catch(() => null), null);
  assert.strictEqual((await page.$eval('#btn', el => el.textContent)).trim(), 'Sign in', 'defaults to Sign in');
  // wrong password → error, no navigation
  await page.fill('#email', 'viewer@vodafone.com');
  await page.fill('#password', 'nope');
  await page.click('#btn');
  await page.waitForSelector('#msg.err', { timeout: 3000 });
  assert.ok(/wrong email or password/i.test(await page.$eval('#msg', el => el.textContent)), 'wrong password shows an error');
  // correct password → session stored, redirect to board (loads as viewer)
  await page.fill('#password', 'secret123');
  await page.click('#btn');
  await page.waitForSelector('#item-1', { timeout: 5000 });
  assert.ok(/\/$|localhost:8903\/$/.test(page.url()), 'signed in and navigated to the board, got ' + page.url());
  assert.strictEqual(await page.getAttribute('body', 'data-role'), 'viewer', 'board loaded as viewer after sign-in');
  assert.ok(posted.some(p => p.mode === 'signin' && p.email === 'viewer@vodafone.com' && p.password === 'secret123'), 'posted a signin with email+password');
  await page.close();
}

// 4b) Create-account tab posts mode:signup
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('signup:' + e.message));
  await page.goto('http://localhost:8903/login', { waitUntil: 'networkidle' });
  await page.click('#tabSignup');
  assert.strictEqual((await page.$eval('#btn', el => el.textContent)).trim(), 'Create account', 'switches to Create account');
  // confirm field appears in signup mode; mismatch is caught client-side
  assert.ok(await page.$eval('#confirmWrap', el => !el.hidden), 'confirm-password field shows in signup');
  await page.fill('#email', 'newhire@vodafone.com');
  await page.fill('#password', 'brandnewpw');
  await page.fill('#confirm', 'different');
  await page.click('#btn');
  await page.waitForSelector('#msg.err', { timeout: 3000 });
  assert.ok(/match/i.test(await page.$eval('#msg', el => el.textContent)), 'mismatched passwords are rejected before submit');
  assert.ok(!posted.some(p => p.mode === 'signup'), 'no signup posted while passwords mismatch');
  // fix the confirm → submits
  await page.fill('#confirm', 'brandnewpw');
  await page.click('#btn');
  await page.waitForSelector('#item-1', { timeout: 5000 });
  assert.ok(posted.some(p => p.mode === 'signup' && p.email === 'newhire@vodafone.com'), 'posted a signup once passwords match');
  await page.close();
}

// 4c) Request-access tab posts mode:request and hides the password field
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('request:' + e.message));
  await page.goto('http://localhost:8903/login', { waitUntil: 'networkidle' });
  await page.click('#tabRequest');
  assert.strictEqual((await page.$eval('#btn', el => el.textContent)).trim(), 'Request access', 'switches to Request access');
  // hidden via its wrapper now (the in-field eye toggle wraps the input), so
  // test actual visibility: offsetParent is null inside a display:none ancestor.
  assert.strictEqual(await page.$eval('#password', el => el.offsetParent === null), true, 'password field hidden in request mode');
  await page.fill('#email', 'newcomer@vodafone.com');
  await page.click('#btn');
  await page.waitForSelector('#msg.ok', { timeout: 3000 });
  assert.ok(/request sent/i.test(await page.$eval('#msg', el => el.textContent)), 'shows request-sent confirmation');
  assert.ok(posted.some(p => p.mode === 'request' && p.email === 'newcomer@vodafone.com'), 'posted a request with email only (no password)');
  assert.ok(posted.find(p => p.mode === 'request' && p.email === 'newcomer@vodafone.com').password === undefined, 'no password sent with a request');
  await page.close();
}

// 5) Change-password page: wrong current errors, correct current succeeds
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('account:' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'viewer-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8903/account', { waitUntil: 'networkidle' });
  // new/confirm mismatch caught client-side
  await page.fill('#current', 'secret123');
  await page.fill('#next', 'newpass12');
  await page.fill('#confirm', 'nope');
  await page.click('#btn');
  await page.waitForSelector('#msg.err', { timeout: 3000 });
  // wrong current → server 401
  await page.fill('#current', 'wrongcurrent');
  await page.fill('#confirm', 'newpass12');
  await page.click('#btn');
  await page.waitForFunction(() => /incorrect/i.test(document.getElementById('msg').textContent), { timeout: 3000 });
  // correct current → ok
  await page.fill('#current', 'secret123');
  await page.click('#btn');
  await page.waitForFunction(() => document.getElementById('msg').classList.contains('ok'), { timeout: 3000 });
  assert.ok(posted.some(p => p.mode === 'change_password' && p.current === 'secret123'), 'posted a change_password with current+new');
  await page.close();
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('ALL TASK 16 FRONTEND TESTS PASSED — login redirect, viewer/admin control gating, login form');
