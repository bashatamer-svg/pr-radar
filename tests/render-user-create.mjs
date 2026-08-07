// Admin → Users → "Add a user": the two options and the result panel.
//
// The server does the provisioning (verify-user-provision pins that); this pins
// what the ADMIN sees, which is where the feature can fail silently:
//   * both options are on screen and DEFAULT ON — a checkbox the admin has to
//     find is a checkbox that stays unticked
//   * unticking one actually reaches the request body
//   * the starter password is DISPLAYED, because it is shown exactly once and
//     the admin is the fallback route to the person when mail fails
//   * a failed send says so in red instead of a green tick
//   * the wider form still fits a 390px phone
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const iso = '2026-08-06T00:00:00Z';
let users = [{ id: 1, email: 'admin@vodafone.com', role: 'admin', active: true, created_at: iso }];
const posts = [];
// What the mocked endpoint answers with next — the page has to render all three
// shapes (created / already had a password / mail failed).
let reply = null;

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    if (u.searchParams.get('view') === 'me') return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
  }
  if (u.pathname === '/api/admin') {
    const view = u.searchParams.get('view'), resource = u.searchParams.get('resource');
    if (req.method === 'GET') {
      if (view === 'users') return j(users);
      return j([]);
    }
    if (req.method === 'POST' && resource === 'users') {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = JSON.parse(b || '{}');
        posts.push(body);
        const row = { id: users.length + 1, email: String(body.email).toLowerCase(), role: body.role, name: body.name || null, active: true, created_at: iso };
        users.push(row);
        j({ ok: true, user: row, role: body.role, ...reply });
      });
      return;
    }
  }
  const f = u.pathname === '/admin' ? '/admin.html' : (u.pathname === '/' ? '/index.html' : u.pathname);
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8911, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
await page.goto('http://localhost:8911/admin', { waitUntil: 'networkidle' });
await page.waitForSelector('#tabs:not([hidden])', { timeout: 4000 });
await page.click('.tab[data-tab="users"]');
await page.waitForSelector('#uAddBtn', { timeout: 4000 });

// 1. The form SAYS what adding someone does. An admin who doesn't know a
//    password is being generated and mailed will not think to check either.
const help = await page.$eval('#content', (el) => el.textContent);
assert.ok(/random temporary password/i.test(help), 'the form says a random temporary password is set');
// The help text must NOT teach a convention any more — there isn't one, and a
// worked example like "tamer123" is exactly the guessability being removed.
assert.ok(!/\b\w+123\b/.test(help), `no first-name+123 example survives in the copy (got "${help.slice(0, 400)}")`);
assert.ok(/name or address/i.test(help), 'and says the password is not derived from their details');
assert.ok(/keeps it/i.test(help), 'and that an existing password is never reset');

// 2. Both options are present and ON by default.
assert.ok(await page.$('#uSub'), 'a daily-brief option exists');
assert.ok(await page.$('#uNotify'), 'an email-them option exists');
assert.strictEqual(await page.$eval('#uSub', (e) => e.checked), true, 'daily brief defaults ON');
assert.strictEqual(await page.$eval('#uNotify', (e) => e.checked), true, 'emailing them defaults ON');

// 3. Add someone with the defaults — the request carries both flags true, and
//    the panel shows the password with a way to copy it.
const TEMP_PW = 'k7mpq-9xnrt-3tbwj-5hzvd-8fcgs-4ynkm';   // shape the server now returns
reply = { credentials: 'created', password: TEMP_PW, subscriber: 'added', emailed: true, emailError: null };
await page.fill('#uEmail', 'tamer.basha@vodafone.com');
await page.fill('#uName', 'Tamer Basha');
await page.click('#uAddBtn');
await page.waitForSelector('#uOut:not([hidden])', { timeout: 4000 });
assert.deepStrictEqual(
  { subscribe: posts[0].subscribe, notify: posts[0].notify, name: posts[0].name },
  { subscribe: true, notify: true, name: 'Tamer Basha' },
  'the defaults reach the server as true, with the name used for the greeting',
);
let out = await page.$eval('#uOut', (el) => el.textContent);
assert.ok(out.includes(TEMP_PW), `the temporary password is displayed in full (got "${out}")`);
assert.ok(/emailed/i.test(out), 'and the send is confirmed');
assert.ok(/Added to the daily brief/i.test(out), 'and the subscription is confirmed');
assert.ok(await page.$('#uCopy'), 'with a copy button for the password');
// The panel must SURVIVE the list refresh that follows — it is the only place
// the password is ever shown.
assert.strictEqual((await page.$$('.row')).length, 2, 'the user list refreshed');
assert.ok(await page.$('#uPw'), 'and the password is still on screen after the refresh');
// The identity fields are cleared, so a second click can't re-provision.
assert.strictEqual(await page.$eval('#uEmail', (e) => e.value), '', 'the email field is cleared');

// 4. Untick the daily brief — it must reach the server as false, not be dropped.
reply = { credentials: 'created', password: 'p4rst-9xnrt-3tbwj-5hzvd-8fcgs-4ynkm', subscriber: 'skipped', emailed: true, emailError: null };
await page.fill('#uEmail', 'quiet.person@vodafone.com');
await page.fill('#uName', 'Quiet Person');
await page.uncheck('#uSub');
await page.click('#uAddBtn');
await page.waitForFunction(() => /Not subscribed/i.test(document.querySelector('#uOut')?.textContent || ''), null, { timeout: 4000 });
assert.strictEqual(posts[1].subscribe, false, 'unticking the box sends subscribe:false');
assert.strictEqual(posts[1].notify, true, 'and leaves the other option alone');
out = await page.$eval('#uOut', (el) => el.textContent);
assert.ok(/Not subscribed/i.test(out), `the panel says they are not on the brief (got "${out}")`);

// 5. A failed send must not read as success — the admin is now the only route.
const BOUNCE_PW = 'b2nce-9xnrt-3tbwj-5hzvd-8fcgs-4ynkm';
reply = { credentials: 'created', password: BOUNCE_PW, subscriber: 'added', emailed: false, emailError: 'resend 422: suppressed address' };
await page.fill('#uEmail', 'bounce@vodafone.com');
await page.fill('#uName', 'Bounce');
await page.check('#uSub');
await page.click('#uAddBtn');
await page.waitForFunction(() => /did NOT send/i.test(document.querySelector('#uOut')?.textContent || ''), null, { timeout: 4000 });
out = await page.$eval('#uOut', (el) => el.textContent);
assert.ok(/suppressed address/.test(out), 'the failure reason is shown');
assert.ok(out.includes(BOUNCE_PW), 'the password is still shown, since it now has to be passed on by hand');
const redText = await page.$eval('#uOut .bad', (el) => el.textContent);
assert.ok(/did NOT send/i.test(redText), 'and the failure is styled as a problem, not a tick');

// 6. Someone who already has a password: no password, no email, said plainly.
reply = { credentials: 'existing', password: null, subscriber: 'already', emailed: null, emailError: null };
await page.fill('#uEmail', 'olduser@vodafone.com');
await page.fill('#uName', 'Old User');
await page.click('#uAddBtn');
await page.waitForFunction(() => /left alone/i.test(document.querySelector('#uOut')?.textContent || ''), null, { timeout: 4000 });
out = await page.$eval('#uOut', (el) => el.textContent);
assert.ok(/left alone/i.test(out), 'says the existing password was not touched');
assert.ok(/no email was sent/i.test(out), 'and that nothing was mailed');
assert.ok(/categories and WhatsApp number were left untouched/i.test(out),
  'and that an existing subscriber row was not overwritten');
assert.strictEqual(await page.$('#uPw'), null, 'no password is displayed for an account we did not create');

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin-add-user.png', fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 1, `no horizontal overflow at 900px (got ${overflow}px)`);

// 7. PHONE WIDTH. Two checkboxes joined a row that already held three inputs, a
//    select and a button. `.form input{flex:1 1 150px}` would have stretched a
//    16px checkbox across the row; the row must wrap and the page must not pan.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(150);
const phone = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(phone <= 1, `no page-level horizontal overflow at 390px (got ${phone}px)`);
const box = await page.$eval('#uSub', (e) => e.getBoundingClientRect().width);
assert.ok(box > 10 && box < 30, `the checkbox keeps its own size instead of flexing (got ${box}px)`);
const btn = await page.$eval('#uAddBtn', (e) => e.getBoundingClientRect().width);
assert.ok(btn > 40, `and the Add button is still a usable size (got ${btn}px)`);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin-add-user-390.png', fullPage: true });

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('USER-CREATE UI OK — both options present and default ON, unticking reaches the request, the starter password is shown once and survives the list refresh, a failed send reads as a failure with its reason, an existing password is reported as left alone, and the widened form fits a 390px phone');
