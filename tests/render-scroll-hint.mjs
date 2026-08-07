// A row that scrolls sideways with a hidden scrollbar gives no sign there is
// more.
//
// The admin tab row holds seven tabs; a 390px phone shows four, and the other
// three did not exist as far as the reader was concerned — no scrollbar, no
// fade, no cut-off tab peeking in. Same for the board's and Trends' filter chip
// rows. The rows were made to scroll WITHIN themselves (rather than pan the
// whole document, which was the previous bug) and the discoverability cost of
// that was never paid.
//
// Fixed with a pure-CSS scroll shadow: two `local` gradients scroll with the
// content and mask two `scroll`-attached shadows, so a shadow shows only on a
// side that has more to reveal. No JS, no wrapper element, and it cannot get out
// of sync with the scroll position because it IS the scroll position.
//
// What must hold: the hint exists, the row still scrolls, every item is still
// reachable, and — the thing this whole family of bugs is about — the DOCUMENT
// still never pans.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + 'public';
const now = new Date().toISOString();
const items = Array.from({ length: 4 }, (_, i) => ({
  id: i + 1, brand: ['Vodafone', 'Orange', 'WE', 'e&'][i], headline: `Story ${i}`, summary: 's',
  sentiment: 'negative', importance: 3, category: 'network', url: 'https://x.example/a',
  resolved_url: 'https://x.example/a', published_at: now, source: 'Youm7', instances: [],
}));

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/items') return j(items);
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
  }
  if (u.pathname.startsWith('/api/')) return j([]);
  const map = { '/': '/index.html', '/admin': '/admin.html', '/stats': '/stats.html', '/login': '/login.html' };
  const f = map[u.pathname] || u.pathname;
  try {
    const b = readFileSync(DIR + f);
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8981, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

/* ── 1. every scrolling row carries the hint ────────────────────────────── */
// Source-level and exhaustive: a row that scrolls sideways and hides its
// scrollbar must have it, or it is the next tab row nobody finds.
{
  for (const f of ['index.html', 'stats.html', 'admin.html']) {
    const html = readFileSync(`${DIR}/${f}`, 'utf8');
    for (const m of html.matchAll(/\.(\w[\w-]*)\{[^}]*overflow-x:\s*auto[^}]*scrollbar-width:\s*none[^}]*\}/g)) {
      const cls = m[1];
      assert.match(m[0], /--edge:/, `${f}: .${cls} hides its scrollbar, so it must declare --edge for the scroll hint`);
      assert.ok(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*scrollhint`).test(html)
             || new RegExp(`class="[^"]*scrollhint[^"]*\\b${cls}\\b`).test(html),
        `${f}: .${cls} carries the scrollhint class`);
    }
  }
}

/* ── 2. it renders, and only where it is needed ─────────────────────────── */
for (const [path, sel, label] of [['/admin', '.tabs', 'the admin tab row'], ['/', '.frow', "the board's filter chips"]]) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8981' + path, { waitUntil: 'networkidle' });
  await page.waitForSelector(sel, { timeout: 5000 });

  const row = await page.$eval(sel, (e) => ({
    bg: getComputedStyle(e).backgroundImage,
    edge: getComputedStyle(e).getPropertyValue('--edge').trim(),
    scrollable: e.scrollWidth > e.clientWidth + 1,
    scrollWidth: e.scrollWidth, clientWidth: Math.round(e.clientWidth),
  }));
  assert.match(row.bg, /radial-gradient/, `${label}: the shadow layers are applied`);
  assert.match(row.bg, /linear-gradient/, `${label}: and the masks that hide them at the ends`);
  assert.ok(row.edge, `${label}: --edge resolves to a real colour, or the mask shows its seams`);
  assert.ok(row.scrollable,
    `${label}: really does overflow at 390px (${row.scrollWidth} > ${row.clientWidth}) — this is the case the hint is for`);

  // THE RULE THIS FAMILY OF BUGS IS ABOUT: the row scrolls, the DOCUMENT does
  // not. Adding a background must not change that.
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `${label}: the page still does not pan sideways at 390px (overflow ${over}px)`);

  // And the far end is genuinely reachable — a hint pointing at content that
  // cannot be scrolled to would be worse than no hint.
  await page.$eval(sel, (e) => { e.scrollLeft = e.scrollWidth; });
  await page.waitForTimeout(100);
  const end = await page.$eval(sel, (e) => ({
    at: Math.round(e.scrollLeft + e.clientWidth), full: e.scrollWidth,
    lastVisible: (() => {
      const kids = [...e.children];
      const last = kids[kids.length - 1];
      const r = last.getBoundingClientRect(), er = e.getBoundingClientRect();
      return r.left >= er.left - 1 && r.right <= er.right + 1;
    })(),
  }));
  assert.ok(Math.abs(end.at - end.full) <= 2, `${label}: scrolls all the way to the end`);
  assert.strictEqual(end.lastVisible, true, `${label}: and the last item is fully visible there`);
  assert.deepStrictEqual(errs, [], `${label}: no page errors`);
  await page.close();
}

/* ── 3. at desktop width, where nothing overflows, it stays invisible ───── */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8981/admin', { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabs', { timeout: 5000 });
  const wide = await page.$eval('.tabs', (e) => e.scrollWidth <= e.clientWidth + 1);
  assert.strictEqual(wide, true, 'the tab row does not overflow at desktop width');
  // The technique is self-cancelling: with nothing to scroll, the `local` masks
  // sit exactly over the `scroll` shadows and nothing shows. Asserted through
  // the property that makes that true, since a shadow is not measurable.
  const bg = await page.$eval('.tabs', (e) => getComputedStyle(e).backgroundImage);
  assert.strictEqual((bg.match(/linear-gradient/g) || []).length, 2,
    'both masking layers are present, which is what makes the hint disappear when there is nothing to hint at');
  await page.close();
}

await browser.close();
server.close();
console.log('SCROLL-HINT OK — every sideways-scrolling row with a hidden scrollbar carries the CSS scroll shadow; it renders at 390px where the rows really do overflow, the page still never pans, the far end and its last item are reachable, and the masking layers that self-cancel at desktop width are present');
