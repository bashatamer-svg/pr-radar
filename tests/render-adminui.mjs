// Task 16 — admin.html Users + Audit tabs (session auth, mocked /api/admin).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const iso = '2026-07-20T00:00:00Z';
let users = [
  { id: 1, email: 'admin@vodafone.com', role: 'admin', active: true, created_at: iso },
  { id: 2, email: 'viewer@vodafone.com', role: 'viewer', active: true, created_at: iso },
];
let audit = [{ id: 1, actor: 'admin@vodafone.com', actor_role: 'admin', action: 'user.add', target: 'viewer@vodafone.com', detail: { role: 'viewer' }, created_at: iso }];
let requests = [{ id: 5, email: 'newcomer@vodafone.com', created_at: iso }];
let subs = [
  { id: 1, email: 'tamer@vodafone.com', name: 'Tamer', categories: null, whatsapp: '201000000001', active: true, created_at: iso },
  { id: 2, email: 'ops@vodafone.com', name: null, categories: ['network'], whatsapp: null, active: true, created_at: iso },
];
let nextId = 6;
const patched = [];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const nc = () => { res.writeHead(204); res.end(); };
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    if (u.searchParams.get('view') === 'me') return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
  }
  if (u.pathname === '/api/admin') {
    const view = u.searchParams.get('view'); const resource = u.searchParams.get('resource');
    if (req.method === 'GET') {
      if (view === 'users') return j(users);
      if (view === 'requests') return j(requests);
      if (view === 'audit') return j(audit);
      if (view === 'author-gap') return j({ missing: 5, days: 7 });
      if (view === 'author-inspect') return j({ days: 30, count: 2, rows: [
        { id: 11, source: 'جريدة كابيتال', headline: 'قصة بلا توقيع', url: 'https://x/1', outcome: 'no-byline', status: 200, author: null, textStart: 'القاهرة — نص وكالة بدون توقيع', candidates: [], subjects: ['Jacques Marco'] },
        { id: 12, source: 'الشروق', headline: 'قصة محجوبة', url: 'https://x/2', outcome: 'fetch-failed', status: 403, author: null, textStart: '', candidates: [], tried: [{ profile: 'desktop', status: 403 }, { profile: 'desktop+referer', status: 403 }, { profile: 'mobile', status: 403 }] },
      ] });
      if (view === 'whatsapp-status') return j({ enabled: true, hasToken: true, hasPhoneId: true, recipients: 2, template: 'pr_urgent' });
      if (view === 'feedback') return j([]);
      if (view === 'subscribers') return j(subs);
      return j([]); // boot probe
    }
    if (req.method === 'POST' && resource === 'backfill-authors') { let b = ''; req.on('data', d => b += d); req.on('end', () => j({ ok: true, days: 7, limit: 40, scanned: 3, filled: 2, remaining: 1, unresolved: 1, fetchFailed: 0, noByline: 0, writeFailed: 0, aiEnabled: true })); return; }
    if (req.method === 'POST' && resource === 'whatsapp-test') { let b = ''; req.on('data', d => b += d); req.on('end', () => j({ ok: true, sent: 2, failed: 0, recipients: 2 })); return; }
    if (req.method === 'POST' && resource === 'users') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const row = { id: nextId++, ...JSON.parse(b), active: true, created_at: iso }; users.push(row); audit.unshift({ id: 9, actor: 'admin@vodafone.com', actor_role: 'admin', action: 'user.add', target: row.email, created_at: iso }); j({ ok: true, user: row }); }); return; }
    if (req.method === 'PATCH') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const body = JSON.parse(b || '{}'); patched.push({ resource, body }); if (resource === 'requests') { requests = requests.filter(x => x.id !== body.id); }
      const editing = body.name !== undefined || body.categories !== undefined || body.whatsapp !== undefined || body.email !== undefined;
      if (!resource && editing) { const row = subs.find(x => x.id === body.id); if (row) Object.assign(row, { email: body.email ?? row.email, name: body.name || null, whatsapp: body.whatsapp || null }); return j({ ok: true, subscriber: row }); }
      nc(); }); return; }
    if (req.method === 'DELETE') { const id = Number(u.searchParams.get('id')); if (resource === 'requests') { requests = requests.filter(x => x.id !== id); } else { users = users.filter(x => x.id !== id); } return nc(); }
  }
  const f = u.pathname === '/admin' ? '/admin.html' : (u.pathname === '/' ? '/index.html' : u.pathname);
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8904, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
// Record every dialog; accept prompts WITH their default value (accept() alone
// submits '' — which would fail the reset flow's generated-password prompt).
const dialogs = []; page.on('dialog', d => { dialogs.push({ type: d.type(), msg: d.message(), def: d.defaultValue() }); d.accept(d.defaultValue()); });
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
await page.goto('http://localhost:8904/admin', { waitUntil: 'networkidle' });
await page.waitForSelector('#tabs:not([hidden])', { timeout: 4000 });

// Users tab
await page.click('.tab[data-tab="users"]');
await page.waitForTimeout(200);
assert.strictEqual((await page.$$('.row')).length, 2, 'two users listed');
await page.fill('#uEmail', 'new.person@vodafone.com');
await page.selectOption('#uRole', 'admin');
await page.click('#uAddBtn');
await page.waitForTimeout(250);
assert.ok(users.find(u => u.email === 'new.person@vodafone.com' && u.role === 'admin'), 'admin added a new admin user');
assert.strictEqual((await page.$$('.row')).length, 3, 'user list grew to 3');

// Reset password — a strong temp password is GENERATED (admin doesn't invent
// one), PATCHed to the API, then shown once for copying.
dialogs.length = 0; patched.length = 0;
await page.click('text=Reset password');   // first user row
await page.waitForTimeout(300);
assert.strictEqual(dialogs.length, 2, `reset flow shows 2 prompts, got ${dialogs.length}`);
assert.ok(dialogs[0].def.length >= 12, 'a temp password is pre-generated');
assert.ok(!/[01OIl]/.test(dialogs[0].def), 'temp password avoids ambiguous characters');
const pwPatch = patched.find(p => p.resource === 'users' && p.body.password);
assert.ok(pwPatch, 'reset PATCHed a password to the API');
assert.strictEqual(pwPatch.body.password, dialogs[0].def, 'the generated password is what was applied');
assert.ok(/Copy it now/.test(dialogs[1].msg) && dialogs[1].def === dialogs[0].def, 'password shown once for copying after apply');

// Requests tab — a pending access request can be approved
await page.click('.tab[data-tab="requests"]');
await page.waitForTimeout(200);
assert.ok(/newcomer@vodafone\.com/.test(await page.$eval('#content', el => el.textContent)), 'pending request shown');
assert.strictEqual((await page.$$('.row')).length, 1, 'one pending request');
await page.click('.row[data-id="5"] .btn.sm');   // Approve (viewer)
await page.waitForTimeout(250);
assert.ok(!requests.find(r => r.id === 5), 'approved request removed from the pending list');
assert.strictEqual((await page.$$('.row')).length, 0, 'requests list now empty');

// Audit tab
await page.click('.tab[data-tab="audit"]');
await page.waitForTimeout(250);
const auditText = await page.$eval('#content', el => el.textContent);
assert.ok(/user\.add/.test(auditText), 'audit tab shows a user.add entry');

// Tools tab — the "Backfill authors" button runs the sweep and shows the summary
await page.click('.tab[data-tab="tools"]');
await page.waitForTimeout(200);
assert.ok(await page.$('#baBtn'), 'Backfill authors button present');
const gapText = await page.$eval('#baGap', el => el.textContent);
assert.ok(/5 cards still missing an author in the last 7 days/.test(gapText), 'backlog indicator shows the count: ' + gapText);
await page.click('#baBtn');
await page.waitForTimeout(300);
const baMsg = await page.$eval('#baMsg', el => el.textContent);
assert.ok(/Filled 2 of 3/.test(baMsg) && /1 still missing/.test(baMsg) && /run again/.test(baMsg), 'backfill result shown with counts + repeat hint: ' + baMsg);
assert.ok(/1 link wouldn.t resolve/.test(baMsg), 'backfill result explains WHY (unresolved link): ' + baMsg);

// Verify verdicts — live re-probe evidence rendered per stuck card
await page.click('#aiBtn');
await page.waitForTimeout(300);
const aiRows = await page.$eval('#aiRows', el => el.textContent);
assert.ok(/no byline on page/.test(aiRows), 'no-byline verdict shown');
assert.ok(/page opens:/.test(aiRows) && /نص وكالة/.test(aiRows), 'opening text shown as evidence');
assert.ok(/blocked \/ unreachable \(403\)/.test(aiRows), 'blocked verdict shown with HTTP status');
assert.ok(/tried: desktop → 403 · desktop\+referer → 403 · mobile → 403/.test(aiRows), 'per-profile attempt evidence shown');
// THE ARTICLE ITSELF. Every other line on this panel is second-hand evidence;
// without a link the admin cannot check the page's real byline, which is exactly
// what a wrong author (an interviewee stored as the journalist) requires.
const aiLink = await page.$eval('#aiRows a[href="https://x/1"]', (el) => ({
  text: el.textContent.trim(), target: el.getAttribute('target'), rel: el.getAttribute('rel') || '',
}));
assert.match(aiLink.text, /open article/i, `each row links to the article (got "${aiLink.text}")`);
assert.strictEqual(aiLink.target, '_blank', 'in a new tab, so the panel is not lost');
assert.ok(/noopener/.test(aiLink.rel), 'with rel=noopener');
assert.ok(/card #11/.test(aiRows), 'and names the card id for cross-reference');
// A name refused as the story's SUBJECT is reported, or "no byline" reads as a
// bug on a page that plainly shows a name.
assert.ok(/refused as the story's subject: Jacques Marco/.test(aiRows), 'a refused subject name is shown: ' + aiRows.slice(0, 200));

// WhatsApp card — status shown, test button enabled + sends
await page.waitForTimeout(150);
const waStatus = await page.$eval('#waStatus', el => el.textContent);
assert.ok(/Configured/.test(waStatus) && /2 recipients/.test(waStatus) && /pr_urgent/.test(waStatus), 'whatsapp status shows configured + recipients + template: ' + waStatus);
assert.ok(!(await page.$eval('#waTestBtn', el => el.disabled)), 'test button enabled when configured');
await page.click('#waTestBtn');
await page.waitForTimeout(250);
const waMsg = await page.$eval('#waMsg', el => el.textContent);
assert.ok(/Sent to 2 of 2/.test(waMsg), 'whatsapp test result shown: ' + waMsg);

// ── EDIT an existing subscriber in place ──
// Before this, changing a name, a category filter or a WhatsApp number meant
// removing the person and re-adding them — which loses their row and, once the
// crisis list moved into this table, risks dropping someone from being paged.
await page.click('.tab[data-tab="subs"]');
await page.waitForSelector('.row[data-id]', { timeout: 3000 });
{
  const firstId = await page.$eval('.row[data-id]', (e) => e.getAttribute('data-id'));
  await page.click(`.row[data-id="${firstId}"] .x.edit`);
  await page.waitForSelector('#eEmail', { timeout: 3000 });
  // The form must arrive PREFILLED — an edit form that starts blank is a
  // delete-and-retype with extra steps, and silently clears what you skip.
  const pre = await page.evaluate(() => ({
    email: document.querySelector('#eEmail').value,
    wa: document.querySelector('#eWa').value,
  }));
  assert.ok(/@/.test(pre.email), `the edit form is prefilled with the current email (got "${pre.email}")`);

  // The format is the one thing an admin cannot guess — a number entered as
  // 01012345678 looks right and silently never delivers. Say it on the form.
  const help = await page.$eval('#content', (e) => e.textContent);
  assert.ok(/country code/i.test(help), 'the form states that the country code is required');
  assert.ok(/201012345678/.test(help), 'with a worked Egyptian example');
  assert.ok(/message the PR Radar number once/i.test(help), 'and the opt-in requirement');

  // A too-short number is refused in the browser, before any request.
  await page.fill('#eWa', '123');
  await page.click('.row[data-id] .btn.sm');
  await page.waitForTimeout(120);
  assert.match(await page.$eval('#eMsg', (e) => e.textContent), /country code/i,
    'a too-short WhatsApp number is rejected with a reason');

  await page.fill('#eWa', '201234567890');
  await page.fill('#eName', 'Edited Name');
  await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/admin/.test(r.url()), { timeout: 3000 }),
    page.click('.row[data-id] .btn.sm'),
  ]);
  await page.waitForTimeout(200);
  assert.strictEqual(await page.$('#eEmail'), null, 'the form closes after a successful save');
}
// Cancel must leave the row untouched.
{
  const firstId = await page.$eval('.row[data-id]', (e) => e.getAttribute('data-id'));
  await page.click(`.row[data-id="${firstId}"] .x.edit`);
  await page.waitForSelector('#eEmail');
  await page.fill('#eName', 'Should Not Persist');
  await page.click('.row[data-id] .btn.ghost.sm');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.$('#eEmail'), null, 'cancel closes the form');
  assert.ok(!/Should Not Persist/.test(await page.content()), 'and discards the typing');
}

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin-users.png', fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// PHONE WIDTH. Seven tabs overflowed a 390px viewport and, because the row had
// no overflow handling of its own, widened the whole DOCUMENT — the page panned
// sideways and the content cards slid off-screen (live, 2 Aug). The row must
// scroll within itself; the desktop-width check above can never catch this.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(120);
const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(phoneOverflow <= 1, `no page-level horizontal overflow at 390px (got ${phoneOverflow}px)`);
const tabsScroll = await page.$eval('#tabs', (el) => ({ over: el.scrollWidth > el.clientWidth, canScroll: getComputedStyle(el).overflowX }));
assert.ok(tabsScroll.over, 'the tab row genuinely has more tabs than fit — the guard is exercising the real case');
assert.strictEqual(tabsScroll.canScroll, 'auto', 'the tab row scrolls within itself instead of widening the page');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 16 ADMIN-UI TESTS PASSED — users list + add, audit tab render');
