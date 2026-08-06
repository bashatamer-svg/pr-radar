// Changing your own password must be reachable, on every device, by every user.
//
// PR Radar has had the page (`/account`) and the endpoint
// (`/api/auth {mode:'change_password'}`) since sign-in shipped. What it did not
// have was a route to them on a PHONE: the header held identity, Password and
// Sign out as three separate pills, the row could not fit them, and the 560px
// rule resolved it with `.account .who,.account .acctlink.pw{display:none}`.
// So the welcome email told every new user to "open Password in the top bar"
// and, two bullets later, to add the board to their home screen — where the link
// did not exist. Nothing failed; the control was simply absent.
//
// Pinned here: one Account button at every width, holding identity + change
// password + sign out; a VIEWER gets it too (they are the ones handed a
// generated starter password); and it behaves like a menu — opens, closes on
// outside click and Escape, and reports its state to assistive tech.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [{ id: 1, brand: 'Vodafone', headline: 'A story', summary: 's', sentiment: 'neutral', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [] }];
let role = 'viewer';

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/auth') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(u.searchParams.get('view') === 'me'
      ? JSON.stringify({ email: 'mona.said@vodafone.com', role, kind: 'user' })
      : '{"supabaseUrl":"","anonKey":""}');
    return;
  }
  const f = u.pathname === '/' ? '/index.html' : (u.pathname === '/account' ? '/account.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(DIR + f)); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8915, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];

// Every width the board is actually read at, INCLUDING the two phone sizes where
// the link used to vanish. 560px is the breakpoint itself — off-by-one there is
// how a control disappears for exactly the people using the smallest screens.
for (const w of [320, 390, 560, 900]) {
  const page = await browser.newPage({ viewport: { width: w, height: 844 } });
  page.on('pageerror', (e) => errs.push(`${w}px: ${e.message}`));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'viewer-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8915/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#acctBtn', { timeout: 5000 });

  const btn = await page.$eval('#acctBtn', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; });
  assert.ok(btn.w > 40 && btn.h > 20, `${w}px: the Account button is a real control (${Math.round(btn.w)}×${Math.round(btn.h)})`);
  assert.ok(btn.right <= w + 1, `${w}px: and it sits inside the viewport (right edge ${Math.round(btn.right)})`);

  // Closed: the panel must have NO box at all, or the header's crush guard ends
  // up measuring a panel nobody can see.
  assert.strictEqual(await page.$eval('#acctMenu', (e) => e.getBoundingClientRect().height), 0, `${w}px: the menu starts closed`);
  assert.strictEqual(await page.getAttribute('#acctBtn', 'aria-expanded'), 'false', `${w}px: and says so`);

  await page.click('#acctBtn');
  assert.strictEqual(await page.getAttribute('#acctBtn', 'aria-expanded'), 'true', `${w}px: opening is announced`);
  const pw = await page.$eval('#account a[href="/account"]', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right, text: e.textContent.trim() }; });
  assert.ok(/change password/i.test(pw.text), `${w}px: the item says what it does (got "${pw.text}")`);
  assert.ok(pw.w > 80 && pw.h >= 30, `${w}px: it is a tappable row (${Math.round(pw.w)}×${Math.round(pw.h)})`);
  assert.ok(pw.left >= 0 && pw.right <= w + 1, `${w}px: the panel does not hang off the screen (${Math.round(pw.left)}–${Math.round(pw.right)})`);
  // Which account you are signed into — the question the menu exists to answer
  // alongside the actions.
  assert.ok(await page.$eval('#account .who .em', (e) => /mona\.said@vodafone\.com/.test(e.textContent) && e.getBoundingClientRect().width > 0),
    `${w}px: the signed-in address is shown in full`);
  assert.ok(await page.$eval('#acctOut', (e) => e.getBoundingClientRect().height > 0), `${w}px: sign out is in the menu too`);
  // Opening a menu must never push the page sideways.
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `${w}px: no horizontal overflow with the menu open (${over}px)`);

  if (w === 390) await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'account-menu-390.png' });
  if (w === 900) await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'account-menu-900.png' });
  await page.close();
}

// Dismissal: outside click and Escape. A menu you can only close by choosing
// something is a menu that traps you — on a phone it covers the board.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errs.push('dismiss: ' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'viewer-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8915/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#acctBtn');

  await page.click('#acctBtn');
  await page.mouse.click(30, 400);                       // somewhere on the board
  assert.strictEqual(await page.$eval('#acct', (e) => e.dataset.open), 'false', 'an outside click closes it');
  assert.strictEqual(await page.getAttribute('#acctBtn', 'aria-expanded'), 'false', 'and aria-expanded follows the panel');

  await page.click('#acctBtn');
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.$eval('#acct', (e) => e.dataset.open), 'false', 'Escape closes it');
  assert.strictEqual(await page.getAttribute('#acctBtn', 'aria-expanded'), 'false', 'and reports that too');

  // The item is a real link, not a handler — it must actually land on the page.
  await page.click('#acctBtn');
  await Promise.all([page.waitForURL(/\/account$/, { timeout: 4000 }), page.click('#account a[href="/account"]')]);
  assert.ok(await page.$('#form'), 'choosing Change password lands on the change-password form');
  // And that form is the real thing: current + new + confirm.
  for (const id of ['#current', '#next', '#confirm']) {
    assert.ok(await page.$(id), `the form has ${id}`);
  }
  await page.close();
}

// An ADMIN keeps the admin pill AND gets the same menu — the two are separate
// concerns and the admin link must not crowd the account one out.
{
  role = 'admin';
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errs.push('admin: ' + e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8915/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#acctBtn');
  assert.ok(await page.$eval('#account a[href="/admin"]', (e) => e.getBoundingClientRect().width > 0), 'admin: the Admin pill is still there at 390px');
  await page.click('#acctBtn');
  assert.ok(await page.$eval('#account a[href="/account"]', (e) => e.getBoundingClientRect().width > 0), 'admin: and the menu still holds Change password');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `admin at 390px: no horizontal overflow (${over}px)`);
  await page.close();
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('ACCOUNT-MENU OK — one Account button at 320/390/560/900px holding the signed-in address, Change password and Sign out; a viewer gets it, an admin keeps the Admin pill beside it, the panel stays on screen and causes no overflow, outside click and Escape dismiss it, and the item lands on the real change-password form');
