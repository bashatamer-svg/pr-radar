// Trends leaderboard rows on a phone (Outlets / Journalists / Categories /
// Narratives) + the Trends header at 320px.
//
// `.lrow` is name + sparkline + bar + value + chevron. Everything except the
// name is unshrinkable — `.val` is flex:none nowrap text ~192px wide ("38 · 24%
// negative · 9 Vod-neg"), `.spark` a fixed 72px, the chevron flex:none — so
// `.nm`, the only shrinkable child, absorbed the entire shortfall. Measured
// before the fix: the outlet name got 0px at 360, **17px at 390**, 57px at 430
// against the 168px it needed, so a leaderboard read "ك.. / D.. / O..", the
// journalist's outlet sub-line collapsed with it, and the sentiment bar was
// squeezed to 0px. Both cards showed nothing but numbers — the "which outlet is
// talking about us" question the page exists to answer was unanswerable on a
// phone, at every phone width, for every row.
//
// The header had the board's old fault too: `.ttl` the only flex:1 child among
// flex:none siblings, so at 320px the row wanted 342px — the page panned 22px
// and the word "Trends" itself truncated.
//
// Pinned here: every row's name renders in full and keeps most of the row, the
// bar survives, the metrics stack beneath the name, the spark is dropped (it was
// already dropped for narrative rows — same reasoning), no page pan at
// 320–430px, and desktop still shows the one-line row WITH its sparkline.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const s5 = [2, 3, 1, 4, 2];
const row = (mentions, negative) => ({ mentions, negative, neutral: mentions - negative, positive: 0, vodNeg: negative, series: s5 });
const stats = {
  meta: { days: 30, generatedAt: new Date().toISOString(), items: 240 },
  days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
  sov: {
    Vodafone: { mentions: s5, negatives: [1, 1, 0, 2, 1] }, Orange: { mentions: [1, 2, 1, 1, 0], negatives: [0, 1, 0, 0, 0] },
    WE: { mentions: [0, 1, 1, 0, 1], negatives: [0, 0, 0, 0, 0] }, 'e&': { mentions: [1, 0, 1, 1, 1], negatives: [0, 0, 1, 0, 0] },
    Market: { mentions: [3, 2, 4, 3, 2], negatives: [0, 0, 0, 1, 0] },
  },
  sentimentByBrand: { Vodafone: { negative: 6, neutral: 20, positive: 8, total: 34 } },
  categories: [{ category: 'network', total: 22, negative: 7, vodNeg: 5, series: s5 }, { category: 'regulatory', total: 14, negative: 3, vodNeg: 2, series: s5 }],
  narratives: [{ name: 'Service outage across Greater Cairo and the operator’s official response', brand: 'Vodafone', total: 12, negative: 8, neutral: 4, positive: 0, series: s5, ids: [1, 2, 3], rising: true, risingScore: 3, headline: 'Cairo subscribers report a four-hour outage' }],
  // Real-shaped names: an Arabic outlet with a section suffix, and a journalist
  // whose row also carries flags + an outlets sub-line — the widest identity.
  outlets: [{ outlet: 'جريدة المال — القسم الاقتصادي', ...row(38, 9) }, { outlet: 'Daily News Egypt', ...row(29, 4) }],
  authors: [{ author: 'محمد عبد الرحمن حسين', outlets: ['اليوم السابع', 'Daily News Egypt'], ...row(18, 4) }, { author: 'Journalist With A Long Name 01', outlets: ['Daily News Egypt'], ...row(12, 2) }],
  totals: { items: 240, negatives: 26, positives: 18, neutrals: 196, vodafone: { mentions: 84, negatives: 12 }, distinctOutlets: 2, distinctAuthors: 2, itemsWithByline: 121 },
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/stats') return j(stats);
  if (u.pathname === '/api/auth') return j(u.searchParams.get('view') === 'me' ? { email: 'a@b.com', role: 'admin', kind: 'user' } : { supabaseUrl: '', anonKey: '' });
  if (u.pathname.startsWith('/api/')) return j({});
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8940, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8940/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('#c-out .lrow', { timeout: 6000 });

const CARDS = [['#c-out', 'outlets'], ['#c-auth', 'journalists'], ['#c-cat', 'categories'], ['#c-narr', 'narratives']];
const rowGeom = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s + ' .lrow');
  if (!r) return null;
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom), need: el.scrollWidth, txt: (el.textContent || '').trim() }; };
  const spark = r.querySelector('.spark');
  return {
    row: Math.round(r.getBoundingClientRect().width),
    nm: box(r.querySelector('.nm')), bar: box(r.querySelector('.bar')), val: box(r.querySelector('.val')),
    sparkShown: spark ? getComputedStyle(spark).display !== 'none' : false,
  };
}, sel);
// `.rows`/`.cbody` measure 8px wider than their box ON PURPOSE: a.lrow carries
// margin:0 -8px so the hover background bleeds to the card edge. That is not
// lost text, and it happens at desktop too — so allow exactly that bleed.
const crushed = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.cardc *, .khead *')) {
    if (el.closest('svg') || el.tagName === 'svg') continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.display === 'none') continue;
    if (el.classList.contains('rows') || el.classList.contains('cbody')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const txt = (el.textContent || '').trim();
    if (!txt && !el.matches('button,a')) continue;
    if (el.scrollWidth > Math.ceil(r.width) + 1) out.push({ cls: (el.className || '').toString().slice(0, 24), txt: txt.slice(0, 24), need: el.scrollWidth, got: Math.round(r.width) });
  }
  return out;
});

// ── phone widths: the name is readable, the bar survives, metrics stack ──
for (const w of [320, 360, 390, 430]) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(220);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `Trends does not pan sideways at ${w}px (overflow ${over}px)`);
  assert.deepStrictEqual(await crushed(), [], `nothing in a Trends card is squeezed below its content width at ${w}px`);
  // The clock is what gives way in the header, not the wordmark.
  assert.ok(await page.$eval('.ttl .h1', (e) => e.scrollWidth <= Math.ceil(e.getBoundingClientRect().width) + 1), `the "Trends" wordmark is not truncated at ${w}px`);
  assert.strictEqual(await page.$eval('.clock', (e) => getComputedStyle(e).display), 'none', `the clock steps aside at ${w}px instead`);

  for (const [sel, label] of CARDS) {
    const g = await rowGeom(sel);
    assert.ok(g, `${label} card rendered`);
    assert.ok(g.nm.need <= g.nm.w + 1, `${label}: the name is rendered in full at ${w}px (needs ${g.nm.need}px, has ${g.nm.w}px)`);
    assert.ok(g.nm.w >= g.row * 0.8, `${label}: the name owns its line at ${w}px (${g.nm.w}px of ${g.row}px — 17px was the bug)`);
    assert.ok(g.nm.txt.length > 6, `${label}: the name is real text, not a stub ("${g.nm.txt.slice(0, 20)}")`);
    assert.ok(g.bar.w > 20, `${label}: the sentiment bar survives at ${w}px (${g.bar.w}px — it was squeezed to 0)`);
    assert.ok(g.val.top >= g.nm.bottom - 2, `${label}: the metrics sit BELOW the name at ${w}px (name ends ${g.nm.bottom}px, value starts ${g.val.top}px)`);
    assert.ok(!g.sparkShown, `${label}: the sparkline gives way on a phone at ${w}px`);
  }
}
await page.setViewportSize({ width: 390, height: 1000 });
await page.waitForTimeout(200);
for (const [sel] of CARDS) {
  const el = await page.$(sel);
  if (el) await el.screenshot({ path: new URL('./out/', import.meta.url).pathname + `trends-${sel.slice(1)}-390.png` });
}

// ── desktop: one line per row, sparkline back, name NOT full width ──
await page.setViewportSize({ width: 1100, height: 1000 });
await page.waitForTimeout(220);
assert.ok(await page.$eval('.clock', (e) => e.getBoundingClientRect().width > 0), 'the clock returns on desktop');
for (const [sel, label] of CARDS) {
  const g = await rowGeom(sel);
  assert.ok(g.val.top < g.nm.bottom, `${label}: name and metrics share one line at desktop width`);
  assert.ok(g.nm.w < g.row * 0.7, `${label}: the name takes its share, not the whole row (${g.nm.w}px of ${g.row}px)`);
  assert.ok(g.bar.w > 20, `${label}: the bar is still drawn at desktop width`);
  assert.ok(g.sparkShown, `${label}: the sparkline returns on desktop`);
}
assert.deepStrictEqual(await crushed(), [], 'nothing crushed at desktop width');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('LEADERBOARD-MOBILE OK — at 320–430px every leaderboard name renders in full and owns its line, the sentiment bar survives, metrics stack beneath, the spark and the header clock give way instead, no page pan; desktop keeps the one-line row with its sparkline');
