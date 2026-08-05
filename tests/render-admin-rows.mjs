// Admin list rows on a phone (Users / Subscribers / Access requests).
//
// A `.row` is identity + an action cluster, and `.acts` is flex:none — so
// `.who`, the only FLEXIBLE child, absorbed every shortfall. The Users row's
// four controls need 303px of the 328px a 390px phone leaves inside the card,
// which left the email **15px** against the 228px it wanted: it rendered as
// "tame…", the role pill was clipped away entirely, and the meta line stacked
// one word per line, 144px tall (live, 6 Aug, iPhone). The document never
// overflowed, so the page-level 390px guard in `render-adminui` could not see
// it — the damage was entirely inside the flex row.
//
// Pinned here: nothing in a row is squeezed below its own content width, the
// identity keeps a readable share of the row, the action cluster wraps BELOW
// the identity instead of starving it, the page still never pans sideways
// (down to 320px, where the cluster has to wrap inside itself), and a desktop
// row is still ONE line — a fix that stacked every row at every width would
// pass a naive mobile assertion while wrecking the wide layout.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const iso = '2026-07-23T00:00:00Z';
// Real-shaped identities: a long address plus a role pill is the widest the
// identity column ever gets, and it is the case that broke.
const users = [
  { id: 1, email: 'tamer.basha@vodafone.com', name: 'Tamer Basha', role: 'admin', active: true, created_at: iso, last_seen_at: '2026-08-06T00:00:00Z' },
  { id: 2, email: 'mohamed.hantera@vodafone.com.eg', name: 'Hantera', role: 'viewer', active: false, created_at: iso, last_seen_at: null },
];
const subs = [
  { id: 1, email: 'tamer.basha@vodafone.com', name: 'Tamer', categories: null, whatsapp: '201000000001', active: true, created_at: iso },
  { id: 2, email: 'ops.communications@vodafone.com', name: null, categories: ['network', 'regulatory'], whatsapp: null, active: true, created_at: iso },
];
const requests = [{ id: 5, email: 'newcomer.longname@vodafone.com', created_at: iso }];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    if (u.searchParams.get('view') === 'me') return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
  }
  if (u.pathname === '/api/admin') {
    const view = u.searchParams.get('view');
    if (view === 'users') return j(users);
    if (view === 'subscribers') return j(subs);
    if (view === 'requests') return j(requests);
    return j([]);                                     // feedback + boot probe
  }
  const f = u.pathname === '/admin' ? '/admin.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8938, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
await page.goto('http://localhost:8938/admin', { waitUntil: 'networkidle' });
await page.waitForSelector('#tabs:not([hidden])', { timeout: 4000 });

const open = async (tab) => { await page.click(`.tab[data-tab="${tab}"]`); await page.waitForSelector('.row[data-id]', { timeout: 3000 }); await page.waitForTimeout(120); };

// An element rendered narrower than its own content is text the user cannot
// read — the same measure `render-header-mobile` uses on the board header.
const crushedIn = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.row .who, .row .who *, .row .acts, .row .acts button')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (el.scrollWidth > Math.ceil(r.width) + 1) out.push({ cls: el.className, txt: (el.textContent || '').trim().slice(0, 24), need: el.scrollWidth, got: Math.round(r.width) });
  }
  return out;
});
// Rows are measured by VERTICAL OVERLAP, not by matching tops: `.acts` is
// centred against a taller identity block, so two items on the same flex line
// legitimately start 8px apart. Overlapping = same line; strictly below = wrapped.
const geom = () => page.evaluate(() => [...document.querySelectorAll('.row[data-id]')].map((row) => {
  const box = (s) => { const el = row.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return { row: Math.round(row.getBoundingClientRect().width), who: box('.who'), em: box('.em'), acts: box('.acts'), pill: box('.em .cat') };
}));

// ── USERS at 390px: the row that broke ──
await open('users');
assert.deepStrictEqual(await crushedIn(), [], 'nothing in a Users row is squeezed below its content width');
for (const r of await geom()) {
  assert.ok(r.who.w >= r.row * 0.6, `the identity keeps most of the row instead of being starved by the buttons (${r.who.w}px of ${r.row}px)`);
  assert.ok(r.acts.top >= r.who.bottom, `the action cluster wraps BELOW the identity at phone width (identity ends ${r.who.bottom}px, actions start ${r.acts.top}px)`);
  assert.ok(r.pill && r.pill.w > 0, 'the role pill survives — an ellipsised identity swallowed it whole');
}
// The email is rendered in full, not truncated to its first few characters.
const emails = await page.$$eval('.row .em', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
assert.ok(emails[0].startsWith('tamer.basha@vodafone.com'), `the whole address is shown (got "${emails[0]}")`);
assert.ok(emails.some((t) => t.includes('mohamed.hantera@vodafone.com.eg')), 'including a long one, which wraps rather than clipping');
// And the meta line reads as a line, not a one-word-per-line column: 144px of
// stacked words was the loudest symptom of the starved column.
const metaH = await page.$eval('.row .nm', (e) => Math.round(e.getBoundingClientRect().height));
assert.ok(metaH <= 40, `the meta line wraps at most twice, not once per word (${metaH}px tall)`);

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin-rows-390.png', fullPage: true });

// ── the compact rows are UNTOUCHED: a cluster that fits stays beside the identity ──
for (const tab of ['subs', 'requests']) {
  await open(tab);
  assert.deepStrictEqual(await crushedIn(), [], `nothing in a ${tab} row is squeezed below its content width`);
}
await open('subs');
for (const r of await geom()) {
  assert.ok(r.acts.top < r.who.bottom, `a subscriber's three icon controls still share the identity's line at 390px (identity ${r.who.top}–${r.who.bottom}px, actions start ${r.acts.top}px)`);
}

// ── 320px: the cluster alone is wider than the card and must wrap INSIDE
// itself. A row that refuses to shrink widens the whole document, which is how
// the admin tab row used to pan the page sideways. ──
await open('users');
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(140);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `no page-level horizontal overflow at ${w}px (got ${over}px)`);
  assert.deepStrictEqual(await crushedIn(), [], `nothing crushed at ${w}px`);
}

// ── desktop: still ONE line. Stacking every row always would have passed the
// phone assertions above while throwing away the wide layout. ──
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(160);
for (const r of await geom()) {
  assert.ok(r.acts.top < r.who.bottom, `identity and actions share one line at desktop width (identity ${r.who.top}–${r.who.bottom}px, actions start ${r.acts.top}px)`);
  assert.ok(r.who.w > 300, `and the identity takes the slack rather than a fixed 180px (${r.who.w}px)`);
}
assert.deepStrictEqual(await crushedIn(), [], 'nothing crushed at desktop width either');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('ADMIN-ROWS OK — at 390px the identity keeps the row and the action cluster wraps beneath it (email, role pill and meta line all readable), compact rows stay inline, no page overflow down to 320px, desktop rows still one line');
