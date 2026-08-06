// The two screens of the forgot-password flow.
//
// The backend is pinned by verify-password-reset; this pins what the two humans
// SEE, which is where a flow like this dies quietly:
//   * the locked-out person: tapping the link actually SENDS something (it used
//     to print advice and post nothing), needs their address first, and is told
//     the same thing whether or not they have an account
//   * the admin: the request is visible with a Reset password button beside it,
//     and Dismiss says out loud that it leaves them locked out
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const posted = [];
let resets = [
  { id: 4, email: 'mona.said@vodafone.com', name: 'Mona Said', role: 'viewer', reset_requested_at: '2026-08-05T09:00:00Z' },
];
const users = [
  { id: 1, email: 'boss@vodafone.com', role: 'admin', active: true, created_at: '2026-08-01T00:00:00Z' },
  { id: 4, email: 'mona.said@vodafone.com', name: 'Mona Said', role: 'viewer', active: true, created_at: '2026-08-02T00:00:00Z', reset_requested_at: '2026-08-05T09:00:00Z' },
];
const deleted = [];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    if (u.searchParams.get('view') === 'me') return j({ email: 'boss@vodafone.com', role: 'admin', kind: 'user' });
    if (req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { posted.push(JSON.parse(b || '{}')); j({ ok: true }); }); return; }
  }
  if (u.pathname === '/api/admin') {
    const view = u.searchParams.get('view'), resource = u.searchParams.get('resource');
    if (req.method === 'GET') {
      if (view === 'resets') return j(resets);
      if (view === 'requests') return j([]);
      if (view === 'users') return j(users);
      return j([]);
    }
    if (req.method === 'DELETE' && resource === 'resets') {
      deleted.push({ id: Number(u.searchParams.get('id')), email: u.searchParams.get('email') });
      resets = resets.filter((r) => r.id !== Number(u.searchParams.get('id')));
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'PATCH') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { posted.push(JSON.parse(b || '{}')); res.writeHead(204); res.end(); }); return; }
  }
  const f = u.pathname === '/login' ? '/login.html' : (u.pathname === '/admin' ? '/admin.html' : (u.pathname === '/' ? '/index.html' : u.pathname));
  // Read BEFORE writing the header: a missing asset (the page asks for
  // /icon.png) would otherwise throw with the 200 already sent, and the catch's
  // writeHead(404) crashes the server rather than serving a 404.
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8917, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];

// ── the locked-out person, on a phone ──
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errs.push('login: ' + e.message));
  await page.goto('http://localhost:8917/login', { waitUntil: 'networkidle' });

  // With no address typed, it must ASK rather than silently post a blank.
  await page.click('#forgot');
  await page.waitForTimeout(120);
  assert.strictEqual(posted.length, 0, 'nothing is sent without an address');
  assert.match(await page.$eval('#msg', (e) => e.textContent), /work email above first/i, 'and it says what it needs');

  await page.fill('#email', 'mona.said@vodafone.com');
  await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && /\/api\/auth/.test(r.url()), { timeout: 4000 }),
    page.click('#forgot'),
  ]);
  await page.waitForTimeout(150);
  const req = posted.find((p) => p.mode === 'reset_request');
  assert.ok(req, 'the tap actually POSTs a reset request — it used to send nothing');
  assert.strictEqual(req.email, 'mona.said@vodafone.com', 'for the typed address');
  const msg = await page.$eval('#msg', (e) => e.textContent);
  assert.match(msg, /request sent/i, `the person is told it went (got "${msg}")`);
  assert.match(msg, /admin/i, 'and who will act on it');
  // No enumeration, and no promise of a reset link that does not exist.
  assert.ok(!/no account|not found|unknown|isn.t registered/i.test(msg), 'without revealing whether the address has an account');
  // It must not promise the person an email — there is no token flow, so anyone
  // waiting on an inbox waits for ever. A NEGATED mention ("we don't email reset
  // links") is the honest wording and must not trip this, so match the promise
  // shapes rather than the words.
  assert.ok(!/check your (inbox|email)|we.{0,4}(ve)? ?(sent|emailed) you|link (has been|was) sent/i.test(msg),
    `and without promising an email to them (got "${msg}")`);
  assert.match(msg, /don.t email reset links/i, 'saying plainly that no reset link is coming');
  // The link is usable again afterwards (its label is restored, not left "Sending…").
  assert.match(await page.$eval('#forgot', (e) => e.textContent), /forgot password/i, 'the link resets its label');
  await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'login-reset-390.png' });
  await page.close();
}

// ── the admin ──
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on('pageerror', (e) => errs.push('admin: ' + e.message));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(d.defaultValue()); });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8917/admin', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tabs:not([hidden])', { timeout: 4000 });

  // The tab badge counts BOTH queues — a waiting reset is as actionable as an
  // access request, and one hidden behind the other is one nobody serves.
  assert.strictEqual(await page.$eval('#nReq', (e) => e.textContent.trim()), '1', 'the Requests badge counts the waiting reset');

  await page.click('.tab[data-tab="requests"]');
  await page.waitForSelector('.row[data-id="4"]', { timeout: 4000 });
  const text = await page.$eval('#content', (e) => e.textContent);
  assert.ok(/Password resets · 1 waiting/.test(text), 'the queue is headed with the count');
  assert.ok(/mona\.said@vodafone\.com/.test(text), 'and names who is waiting');
  assert.ok(/Resetting clears the request automatically/i.test(text), 'and explains that the queue empties itself');
  assert.ok(/no self-service reset link on purpose/i.test(text), 'and why there is no reset link');

  // Reset password, straight from the queue row.
  await page.click('.row[data-id="4"] .btn.sm');
  await page.waitForTimeout(300);
  const patch = posted.find((p) => p.password);
  assert.ok(patch, 'the row resets the password through the API');
  assert.strictEqual(patch.email, 'mona.said@vodafone.com', 'for the right person');
  assert.ok(patch.password.length >= 12, 'with a generated strong password, not one the admin invents');
  assert.ok(dialogs.some((d) => /Copy it now/.test(d)), 'and shows it once for copying');

  // Dismiss must say out loud what it does NOT do.
  await page.click('.row[data-id="4"] .x');
  await page.waitForTimeout(250);
  assert.ok(dialogs.some((d) => /password is unchanged/i.test(d)), 'dismiss warns the password is unchanged');
  assert.deepStrictEqual(deleted, [{ id: 4, email: 'mona.said@vodafone.com' }], 'and dismisses that request server-side');
  assert.ok(/Nobody is waiting on a password/.test(await page.$eval('#content', (e) => e.textContent)), 'the queue empties on screen');

  // The Users tab flags it too, so an admin who never opens Requests still sees it.
  await page.click('.tab[data-tab="users"]');
  await page.waitForSelector('.row[data-id="4"]', { timeout: 4000 });
  assert.ok(await page.$eval('.row[data-id="4"] .cat.rst', (e) => /reset asked/i.test(e.textContent) && e.getBoundingClientRect().width > 0),
    'the user row carries a visible "reset asked" chip');
  await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin-resets-900.png' });
  await page.close();
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('RESET-UI OK — "Forgot password?" needs an address, really POSTs the request, and answers without revealing whether the account exists or promising a reset link; the admin sees it in the Requests badge and queue, can reset straight from the row (generated password, shown once), Dismiss warns the password is unchanged, and the Users tab carries a "reset asked" chip');
