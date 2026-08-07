// The board card's action footer on a phone.
//
// A card footer is 3 controls for a viewer but EIGHT for an admin — Copy brief,
// 📸, 🔔, 📌, 🙈, ▲, ▼ and Open source — which is 359px of controls in the 322px
// a 390px phone leaves inside a card. `.foot` had no wrap, so every control
// shrank instead: both labelled buttons folded into FOUR lines inside 59px and
// 69px boxes, the icon buttons dropped from their designed 38px touch target to
// 30px, and the row still overflowed, panning the whole page sideways (3px at
// 390px, 33px at 360px, 73px at 320px). Same fault as the admin list rows and
// the board header: a row of `flex:none`-shaped controls with nowhere to give.
//
// Wrapping — not `overflow-x` — is the fix for a footer: an action a reader has
// to discover by scrolling sideways may as well not be there.
//
// Pinned here: the row can wrap, every control keeps its designed size at phone
// width, both labels stay on one line, Open source stays right-aligned, the
// page never pans, and a VIEWER's three-control footer is still a single line
// at every width (the common case must not get taller).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [{
  id: 1, brand: 'Vodafone', headline: 'أزمة انقطاع الخدمة في القاهرة الكبرى وبيان رسمي من الشركة',
  summary: 'تفاصيل الانقطاع وردود الفعل الرسمية.', sentiment: 'negative', importance: 5, category: 'network',
  url: 'https://x/1', resolved_url: 'https://x/1', published_at: now, author: 'محمد عبد الرحمن', source: 'اليوم السابع',
  pr_angle: 'اعتراف سريع + جدول زمني', team_share: null,
  instances: [{ outlet: 'اليوم السابع', author: 'محمد عبد الرحمن', url: 'https://x/1' }],
}];

let role = 'admin';                                  // flipped + reloaded below
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/items') return j(items);
  if (u.pathname === '/api/auth') return j(u.searchParams.get('view') === 'me'
    ? { email: 'someone@vodafone.com', role, kind: 'user' } : { supabaseUrl: '', anonKey: '' });
  if (u.pathname.startsWith('/api/')) return j({});
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8939, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8939/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 5000 });

// An element rendered narrower than its own content is text the user cannot
// read — the same measure `render-header-mobile` applies to the header.
const crushedInCards = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.card, .card *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!(el.textContent || '').trim() && !el.matches('button,a')) continue;
    if (el.scrollWidth > Math.ceil(r.width) + 1) out.push({ cls: (el.className || '').toString(), txt: (el.textContent || '').trim().slice(0, 20), need: el.scrollWidth, got: Math.round(r.width) });
  }
  return out;
});
const footGeom = () => page.evaluate(() => {
  const foot = document.querySelector('.card .foot');
  const vis = [...foot.children].filter((k) => k.getBoundingClientRect().width > 0);
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  return {
    wrap: getComputedStyle(foot).flexWrap,
    foot: box(foot),
    controls: vis.length,
    icons: vis.filter((k) => k.classList.contains('fb')).map(box),
    labelled: vis.filter((k) => k.classList.contains('btn')).map((k) => ({ ...box(k), need: k.scrollWidth, txt: k.textContent.trim() })),
    open: box(foot.querySelector('.btn.open')),
    // Lines are counted by VERTICAL OVERLAP, not by matching tops: the labelled
    // buttons are 33px and the icons 36px, centred, so two controls on the same
    // line legitimately start 1–2px apart.
    lines: (() => {
      const rs = vis.map((k) => k.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      let n = 0, floor = -Infinity;
      for (const r of rs) { if (r.top >= floor - 2) { n++; floor = r.bottom; } else floor = Math.max(floor, r.bottom); }
      return n;
    })(),
  };
});

// ── ADMIN at 390px: the case that broke ──
{
  const g = await footGeom();
  assert.strictEqual(g.wrap, 'wrap', 'the footer can wrap — that is what stops it shrinking its controls');
  // FIVE now, not eight: Copy · 📸 · 🔔 · ••• · Open source. The wrap fix made
  // eight FIT; it could not make eight equally-weighted icons easy to scan, so
  // pin / hide / useful / not-useful moved into the ••• menu. Both facts still
  // matter — the row must still be able to break, because five controls plus a
  // 100-character headline is still over-subscribed at 320px.
  assert.strictEqual(g.controls, 5, `an admin gets five PRIMARY controls (got ${g.controls})`);
  assert.deepStrictEqual(await crushedInCards(), [], 'nothing in the card is squeezed below its content width at 390px');
  for (const i of g.icons) {
    assert.strictEqual(i.w, 38, `each icon button keeps its designed 38px touch target (got ${i.w}px)`);
    assert.strictEqual(i.h, 36, `and its 36px height (got ${i.h}px)`);
  }
  for (const b of g.labelled) {
    assert.ok(b.h <= 40, `"${b.txt}" keeps its label on ONE line (${b.h}px tall — 4 lines was the bug)`);
    assert.ok(b.need <= b.w + 1, `"${b.txt}" is not clipped (needs ${b.need}px, has ${b.w}px)`);
  }
  // Open source stays the right-hand anchor wherever it wraps to.
  assert.ok(g.open.right >= g.foot.right - 1, `Open source stays right-aligned (button right ${g.open.right}px, footer right ${g.foot.right}px)`);
  await (await page.$('.card .foot')).screenshot({ path: new URL('./out/', import.meta.url).pathname + 'card-foot-admin-390.png' });
}

// ── no page-level pan at any phone width ──
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(150);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `the board does not pan sideways at ${w}px (overflow ${over}px)`);
  assert.deepStrictEqual(await crushedInCards(), [], `nothing crushed in a card at ${w}px`);
  const g = await footGeom();
  for (const i of g.icons) assert.strictEqual(i.w, 38, `icon buttons keep 38px at ${w}px (got ${i.w}px)`);
  for (const b of g.labelled) assert.ok(b.h <= 40, `"${b.txt}" stays one line at ${w}px (${b.h}px)`);
}

// ── desktop: one line, exactly as before ──
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(150);
{
  const g = await footGeom();
  assert.strictEqual(g.lines, 1, `the admin footer is a single row at desktop width (got ${g.lines} lines)`);
  assert.deepStrictEqual(await crushedInCards(), [], 'nothing crushed at desktop width');
}

/* ── the ••• More menu ────────────────────────────────────────────────────
   Moving four controls into a menu is only an improvement if the menu is
   genuinely usable: reachable by keyboard, dismissable without choosing, and
   never clipped by the card it hangs off. */
{
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.card .foot', { timeout: 5000 });

  const menuBox = async () => page.evaluate(() => {
    const m = document.querySelector('.card .moremenu');
    const card = document.querySelector('.card');
    const r = m.getBoundingClientRect(), c = card.getBoundingClientRect();
    return { open: getComputedStyle(m).display !== 'none', w: Math.round(r.width),
             left: Math.round(r.left), right: Math.round(r.right),
             cardLeft: Math.round(c.left), cardRight: Math.round(c.right),
             items: [...m.querySelectorAll('.mitem')].map((i) => i.textContent.trim()) };
  });

  assert.strictEqual((await menuBox()).open, false, 'the menu starts closed');
  assert.strictEqual(await page.getAttribute('.card .morebtn', 'aria-expanded'), 'false',
    'and says so');

  await page.click('.card .morebtn');
  let m = await menuBox();
  assert.strictEqual(m.open, true, 'clicking ••• opens it');
  assert.strictEqual(await page.getAttribute('.card .morebtn', 'aria-expanded'), 'true',
    'and aria-expanded moves WITH the panel');

  // No behaviour loss: all four moved actions are here, and named in words
  // rather than as the bare icons they used to be.
  assert.strictEqual(m.items.length, 4, 'all four moved actions are present');
  for (const want of [/Pin for the team/, /Hide from the team/, /Useful/, /Not useful/]) {
    assert.ok(m.items.some((t) => want.test(t)), `the menu offers ${want}`);
  }

  // NOT CLIPPED. Anchored to the footer's right edge rather than to the •••
  // button, so it stays inside the card whichever line the button wraps onto —
  // button-anchored, it overflows left when ••• lands at the start of a row.
  assert.ok(m.left >= m.cardLeft - 1, `the menu does not overflow the card's left edge (${m.left} vs ${m.cardLeft})`);
  assert.ok(m.right <= m.cardRight + 1, `nor its right edge (${m.right} vs ${m.cardRight})`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `and the open menu does not pan the page at 390px (overflow ${over}px)`);

  // Keyboard: opening focuses the first item, arrows walk the list, Escape
  // closes AND returns focus — an Escape that strands you at the top of the
  // document is a menu a keyboard user cannot leave.
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('mitem')),
    'opening the menu focuses its first item');
  await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('hide')),
    'ArrowDown walks to the next item');
  await page.keyboard.press('ArrowUp');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('pin')),
    'ArrowUp walks back');
  await page.keyboard.press('Escape');
  assert.strictEqual((await menuBox()).open, false, 'Escape closes it');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('morebtn')),
    'and returns focus to the button that opened it');

  // An outside click closes it too. A menu you can only dismiss by picking
  // something is a menu that traps you.
  await page.click('.card .morebtn');
  assert.strictEqual((await menuBox()).open, true);
  await page.click('.card .headline');
  assert.strictEqual((await menuBox()).open, false, 'clicking away closes it');

  // Choosing an item acts AND closes, and the label follows the new state.
  await page.click('.card .morebtn');
  await page.click('.card .mitem.pin');
  await page.waitForTimeout(200);
  assert.strictEqual((await menuBox()).open, false, 'choosing an item closes the menu');
  assert.ok(await page.$('.card.pinned'), 'and the action actually ran');
  await page.click('.card .morebtn');
  m = await menuBox();
  assert.ok(m.items.some((t) => /Unpin/.test(t)),
    'and the label reads Unpin next time — "Pin" while already pinned would be a lie');
  await page.keyboard.press('Escape');
}

// ── VIEWER: three controls, ONE line at every width. The wrap must not make
// the common case taller than it was. ──
role = 'viewer';
for (const w of [360, 390, 1100]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });
  await page.waitForTimeout(150);
  const g = await footGeom();
  // Unchanged for a viewer: the menu is admin-only, so their card is exactly
  // what it was. This change must cost the majority of readers nothing.
  assert.strictEqual(g.controls, 3, `a viewer sees Copy, 📸 and Open only (got ${g.controls} at ${w}px)`);
  assert.strictEqual(g.lines, 1, `and they share ONE line at ${w}px (got ${g.lines})`);
  assert.ok(g.open.right >= g.foot.right - 1, `Open source still right-aligned for a viewer at ${w}px`);
  assert.deepStrictEqual(await crushedInCards(), [], `nothing crushed for a viewer at ${w}px`);
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log("CARD-FOOT OK — an admin's five PRIMARY controls wrap instead of shrinking (the other four live in the ••• menu, which opens by keyboard, closes on Escape and on an outside click, is never clipped, and keeps its labels in step with state) (icons keep 38px, both labels one line, Open source right-aligned), the board never pans at 320–390px, desktop is one row, and a viewer's three controls stay on one line");
