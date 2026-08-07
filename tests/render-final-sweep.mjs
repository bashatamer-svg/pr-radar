// The whole app, both roles, six widths — the sweep the individual page tests
// each do for their own area, run across everything at once.
//
// It exists to catch the class of bug this codebase keeps meeting: a layout
// that is fine on the page someone was working on and broken on the one they
// weren't. The rules are the ones already learned here the hard way:
//
//   * the DOCUMENT never pans sideways (a row may scroll; the page may not)
//   * nothing renders narrower than its own content — text you cannot read
//   * a touch target stays a touch target
//   * a VIEWER never sees, or can reach, an admin control
//   * no page throws
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + 'public';
const WIDTHS = [320, 360, 390, 430, 768, 1280];
const now = new Date().toISOString();

// Real-shaped content: long Arabic and English headlines, a byline, coverage
// across several outlets — the values that actually stress a layout.
const items = [
  { id: 1, brand: 'Vodafone', headline: 'فودافون مصر تواجه انتقادات واسعة بعد انقطاع خدمة فودافون كاش لساعات في القاهرة والجيزة',
    summary: 'انقطاع خدمة فودافون كاش', pr_angle: 'Read · x\nAudience · y\nAction · z', sentiment: 'negative',
    importance: 5, category: 'vodafone_cash', url: 'https://youm7.example/a', resolved_url: 'https://youm7.example/a',
    published_at: now, author: 'محمد عبد الرحمن', source: 'اليوم السابع',
    instances: [{ outlet: 'اليوم السابع', url: 'https://youm7.example/a', author: 'محمد عبد الرحمن' },
                { outlet: 'Daily News Egypt', url: 'https://dne.example/a', author: null },
                { outlet: 'Al Mal News', url: 'https://almal.example/a', author: 'Doaa A.Moneim' }] },
  { id: 2, brand: 'Orange', headline: 'Orange Egypt announces a nationwide fibre expansion programme worth several billion pounds',
    summary: 'Orange fibre expansion', sentiment: 'positive', importance: 2, category: 'corporate',
    url: 'https://dne.example/b', resolved_url: 'https://dne.example/b', published_at: now,
    author: null, source: 'Daily News Egypt', instances: [] },
];
const stats = {
  meta: { days: 30, generatedAt: now, items: 2 }, days: [now.slice(0, 10)],
  sov: Object.fromEntries(['Vodafone', 'Orange', 'WE', 'e&', 'Market'].map((b) => [b, { mentions: [1], negatives: [1] }])),
  sentimentByBrand: Object.fromEntries(['Vodafone', 'Orange', 'WE', 'e&', 'Market']
    .map((b) => [b, { negative: 1, neutral: 0, positive: 0, total: 1 }])),
  categories: [{ category: 'vodafone_cash', total: 2, negative: 1, vodNeg: 1, series: [1] }],
  narratives: [], narrativesPending: false,
  outlets: [{ outlet: 'اليوم السابع', mentions: 9, negative: 6, neutral: 3, positive: 0, vodNeg: 6, series: [1] }],
  authors: [{ author: 'محمد عبد الرحمن', mentions: 5, negative: 4, neutral: 1, positive: 0, vodNeg: 4, outlets: ['اليوم السابع'], series: [1] }],
  totals: { items: 2, negatives: 1, positives: 1, neutrals: 0, vodafone: { mentions: 1, negatives: 1 },
    distinctOutlets: 3, distinctAuthors: 2, itemsWithByline: 1 },
};

let ROLE = 'admin';
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/items') return j(items);
  if (u.pathname === '/api/stats') return j(stats);
  if (u.pathname === '/api/alerts') return j({ generatedAt: now, status: 'ok', checks: [], logAvailable: false, log: [],
    build: { shortSha: 'abc1234', ref: 'main', environment: 'production', known: true, instanceStartedAt: now } });
  if (u.pathname === '/api/context') return j({ content: '', updated_at: null });
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    return j({ email: `${ROLE}@vodafone.com`, role: ROLE, kind: 'user' });
  }
  if (u.pathname.startsWith('/api/')) return j([]);
  const map = { '/': '/index.html', '/stats': '/stats.html', '/admin': '/admin.html', '/login': '/login.html',
    '/account': '/account.html', '/reports': '/reports.html', '/guide': '/guide.html', '/context': '/context.html' };
  const f = map[u.pathname] || u.pathname;
  try {
    const b = readFileSync(DIR + f);
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8991, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// An element rendered narrower than its own content is text nobody can read —
// the measure render-header-mobile introduced after "PR Radar" became "P…".
const audit = (page) => page.evaluate(() => {
  const crushed = [], small = [];
  const SKIP = /moremenu|mitem|msep/;      // closed menu: measured when open, in render-card-foot
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;                 // hidden
    if (getComputedStyle(el).overflowX === 'auto') continue;       // deliberately scrolls
    // SVG has its own coordinate system, so scrollWidth on a <text> node is not
    // a width in CSS pixels and comparing the two is meaningless. Chart-label
    // legibility is measured properly by render-leaderboard-mobile.
    if (el instanceof SVGElement) continue;
    const cls = (el.className || '').toString();
    if (SKIP.test(cls)) continue;
    if (el.children.length === 0 && (el.textContent || '').trim()
        && el.scrollWidth > Math.ceil(r.width) + 1) {
      crushed.push({ cls, txt: (el.textContent || '').trim().slice(0, 24), need: el.scrollWidth, got: Math.round(r.width) });
    }
    // Touch targets. Scoped to controls that are BOXES — an inline link inside
    // a sentence or a dense coverage list is typography, and its line-height is
    // not a hit-target failure. What must not shrink is anything laid out as a
    // block, flex or grid item: those are the buttons and chips a thumb aims at.
    if (el.matches('button, a[href], input, select') && r.width > 0) {
      const disp = getComputedStyle(el).display;
      if (disp === 'inline') continue;
      if (r.height < 24 || r.width < 18) small.push({ cls, txt: (el.textContent || '').trim().slice(0, 18), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return {
    crushed, small,
    pan: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

const PAGES = ['/', '/stats', '/admin', '/reports', '/account', '/login', '/guide'];
for (const role of ['admin', 'viewer']) {
  ROLE = role;
  for (const path of PAGES) {
    // /admin is admin-only by design; a viewer gets a gate, not a layout.
    if (role === 'viewer' && path === '/admin') continue;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(`${path}[${role}]: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8991' + path, { waitUntil: 'networkidle' });

    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(140);
      const a = await audit(page);
      assert.ok(a.pan <= 1, `${path} [${role}] pans sideways at ${w}px (overflow ${a.pan}px)`);
      assert.deepStrictEqual(a.crushed, [],
        `${path} [${role}] at ${w}px renders elements narrower than their own content`);
      assert.deepStrictEqual(a.small, [],
        `${path} [${role}] at ${w}px has controls below a usable touch target`);
    }
    assert.deepStrictEqual(errs, [], `${path} [${role}] threw`);
    await page.close();
  }
}

/* ── a viewer cannot see OR reach an admin control ──────────────────────── */
{
  ROLE = 'viewer';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
  await page.goto('http://localhost:8991/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });
  assert.strictEqual(await page.getAttribute('body', 'data-role'), 'viewer', 'the page knows the role');

  // Not visible…
  for (const sel of ['.more', '.fb.alert']) {
    const shown = await page.$eval(sel, (e) => e.getBoundingClientRect().width > 0).catch(() => false);
    assert.strictEqual(shown, false, `viewer: ${sel} is not shown`);
  }
  // …and not reachable, which is the part that matters: a control hidden by CSS
  // is still in the DOM and still clickable by script or by keyboard.
  const reachable = await page.evaluate(() => [...document.querySelectorAll('.mitem, .fb.alert, .morebtn')]
    .filter((e) => e.offsetParent !== null).length);
  assert.strictEqual(reachable, 0, 'viewer: no admin control is focusable or clickable');
  // The admin link is absent too.
  assert.strictEqual(await page.$('a[href="/admin"]'), null, 'viewer: no admin link');
  await page.close();
}

/* ── reduced motion is respected ────────────────────────────────────────── */
{
  ROLE = 'admin';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
  await page.goto('http://localhost:8991/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });
  assert.deepStrictEqual(errs, [], 'the board works under prefers-reduced-motion');
  // The board reads the preference itself (RM in index.html) — the cards must
  // still be there, whatever it does with the animation.
  assert.ok((await page.$$('.card')).length >= 2, 'and still renders every card');
  await page.close();
}

/* ── keyboard: the first control on each page is reachable by Tab ───────── */
{
  ROLE = 'admin';
  for (const path of ['/', '/stats', '/admin', '/reports', '/login']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8991' + path, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const e = document.activeElement;
      return e && e !== document.body ? { tag: e.tagName, visible: e.getBoundingClientRect().width > 0 } : null;
    });
    assert.ok(focused, `${path}: Tab moves focus into the page`);
    assert.ok(focused.visible, `${path}: and onto something visible, not a hidden control`);
    await page.close();
  }
}

/* ── RTL: Arabic headlines get direction, not just a font ───────────────── */
{
  ROLE = 'admin';
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
  await page.goto('http://localhost:8991/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#item-1', { timeout: 5000 });
  // The app uses `unicode-bidi: plaintext` rather than dir="auto": each block
  // takes its base direction from its OWN first strong character, which is what
  // keeps a headline mixing Arabic with "Vodafone Cash" and "5G" in the right
  // order. verify-bidi proves the resulting GEOMETRY; this only confirms the
  // mechanism is still applied to the headline, summary and coverage rows.
  const bidi = await page.$$eval('#item-1 .headline, #item-1 .summary',
    (els) => els.map((e) => getComputedStyle(e).unicodeBidi));
  assert.ok(bidi.length >= 1, 'the Arabic card rendered');
  for (const b of bidi) {
    assert.strictEqual(b, 'plaintext',
      'Arabic text takes its base direction from its own content, or Latin punctuation lands at the wrong end');
  }
  await page.close();
}

await browser.close();
server.close();
console.log(`FINAL-SWEEP OK — ${PAGES.length} pages × ${WIDTHS.length} widths × 2 roles: no page pans, nothing renders narrower than its content, no control falls below a usable touch target, no page throws; a viewer cannot see OR reach an admin control; reduced motion, Tab focus and Arabic direction all hold`);
