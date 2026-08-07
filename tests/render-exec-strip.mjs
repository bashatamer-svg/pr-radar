// Trends' "So what?" strip.
//
// The page opened on charts. A chart answers "what does the shape look like",
// which is the second question — the first is "what changed, and who do I need
// to talk to". A PR reader was deriving that by eye from five cards every
// morning, which is work the page can do.
//
// The whole value depends on the strip being TRUSTABLE, so this test is mostly
// about what it must NOT say:
//   * never a claim without the numbers behind it
//   * never a comparison with no baseline to compare against
//   * never a line when nothing qualifies — it says so instead
//   * never a number that disagrees with the card underneath it
//   * and no LLM anywhere near it
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + 'public';
const day = (i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
const DAYS = Array.from({ length: 10 }, (_, i) => day(9 - i));      // oldest → today
const zeros = () => DAYS.map(() => 0);

// Halves: days 0–4 are "before", 5–9 are "now".
const series = (before, now) => DAYS.map((_, i) => (i < 5 ? before : now));

let DATA = null;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/stats') return j(DATA);
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    return j({ email: 'a@b.com', role: 'viewer', kind: 'user' });
  }
  if (u.pathname.startsWith('/api/')) return j([]);
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
  try {
    const b = readFileSync(DIR + f);
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8971, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const base = (over = {}) => ({
  meta: { days: 10, generatedAt: new Date().toISOString(), items: 40 },
  days: DAYS,
  sov: {
    Vodafone: { mentions: series(2, 2), negatives: series(1, 3) },
    Orange: { mentions: series(1, 1), negatives: zeros() },
    WE: { mentions: series(1, 1), negatives: zeros() },
    'e&': { mentions: series(1, 1), negatives: zeros() },
    Market: { mentions: zeros(), negatives: zeros() },
  },
  sentimentByBrand: Object.fromEntries(['Vodafone', 'Orange', 'WE', 'e&', 'Market']
    .map((b) => [b, { negative: 0, neutral: 0, positive: 0, total: 0 }])),
  categories: [
    { category: 'vodafone_cash', total: 12, negative: 9, vodNeg: 9, series: zeros() },
    { category: 'network', total: 8, negative: 3, vodNeg: 3, series: zeros() },
  ],
  narratives: [], outlets: [], authors: [],
  narrativesPending: false,
  totals: { items: 40, negatives: 20, positives: 4, neutrals: 16,
    vodafone: { mentions: 20, negatives: 20 }, distinctOutlets: 9, distinctAuthors: 4, itemsWithByline: 12 },
  ...over,
});

const load = async (data) => {
  DATA = data;
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
  await page.goto('http://localhost:8971/stats', { waitUntil: 'networkidle' });
  await page.waitForSelector('.exec', { timeout: 5000 });
  const rows = await page.$$eval('.exec .exrow', (els) => els.map((e) => ({
    text: e.textContent.replace(/\s+/g, ' ').trim(),
    href: e.querySelector('a')?.getAttribute('href') || null,
    tone: [...(e.querySelector('.exdot')?.classList || [])].find((c) => c !== 'exdot') || null,
  })));
  const empty = await page.$eval('.exec', (e) => !!e.querySelector('.exempty'));
  return { page, rows, empty, errs };
};

/* ── 1. it is ABOVE the detail, and it is the "so what" ─────────────────── */
{
  const { page, rows, errs } = await load(base());
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector('#content').children];
    return { exec: kids.findIndex((k) => k.classList.contains('exec')),
             firstChart: kids.findIndex((k) => k.classList.contains('cardc')) };
  });
  assert.ok(order.exec > -1 && order.exec < order.firstChart,
    'the strip sits above the detailed charts');
  assert.match(await page.textContent('.exhead'), /So what/i, 'and says what it is for');
  assert.deepStrictEqual(errs, [], 'no page errors');

  // Every line carries its own numbers. A callout the reader cannot check
  // against the card underneath is one they have to take on faith.
  for (const r of rows) {
    assert.match(r.text, /\d/, `"${r.text}" states the numbers behind it`);
  }
  await page.close();
}

/* ── 2. the movement line is real arithmetic, both directions ───────────── */
{
  // 5 negatives before, 15 after: up 200%.
  let { page, rows } = await load(base());
  const up = rows.find((r) => /Vodafone negatives/.test(r.text));
  assert.ok(up, 'it reports the movement in Vodafone negatives');
  assert.match(up.text, /up/, 'up when it rose');
  assert.match(up.text, /\+200%/, 'with the arithmetic right (5 → 15)');
  assert.match(up.text, /15 in the last 5d, 5 vs the previous 5 days/,
    'and states both halves, so the comparison is checkable');
  assert.strictEqual(up.tone, 'bad', 'and is marked as bad news');
  // The board window (&win=) comes from boardWin(), the same mapping every
  // other Trends link uses — asserted by shape, not by a hardcoded value.
  assert.match(up.href, /^\/\?brand=Vodafone&sent=negative&win=\d+$/,
    `it opens exactly those cards on the board (got ${up.href})`);
  await page.close();

  // The other direction must read as GOOD, or the strip only ever alarms.
  ({ page, rows } = await load(base({
    sov: { ...base().sov, Vodafone: { mentions: series(2, 2), negatives: series(4, 1) } },
  })));
  const down = rows.find((r) => /Vodafone negatives/.test(r.text));
  assert.match(down.text, /down/, 'down when it fell');
  assert.match(down.text, /-75%/, 'with the arithmetic right (20 → 5)');
  assert.strictEqual(down.tone, 'good', 'and reads as good news');
  await page.close();
}

/* ── 3. NO BASELINE, NO CLAIM ───────────────────────────────────────────── */
{
  // A rise from zero is not a percentage. The line may still appear (the counts
  // are real) but it must not divide by nothing.
  const { page, rows } = await load(base({
    sov: { ...base().sov, Vodafone: { mentions: series(0, 2), negatives: series(0, 6) } },
  }));
  const line = rows.find((r) => /Vodafone negatives/.test(r.text));
  assert.ok(line, 'it still reports the counts');
  assert.ok(!/%/.test(line.text), `and states NO percentage against a zero baseline (got "${line.text}")`);
  await page.close();
}
{
  // A window too short to have two halves produces no comparison at all.
  const short = base();
  short.days = DAYS.slice(0, 2); short.meta.days = 2;
  for (const b of Object.keys(short.sov)) short.sov[b] = { mentions: [1, 4], negatives: [1, 4] };
  const { page, rows } = await load(short);
  assert.ok(!rows.some((r) => /vs the previous/.test(r.text)),
    'a two-day window makes no period-over-period claim — there is nothing to compare with');
  await page.close();
}
{
  // A rival "gaining" off one mention in the whole earlier half is noise: the
  // percentage would be enormous and the fact behind it trivial. The bar is a
  // baseline of at least two, which is the difference between a trend and a
  // coincidence.
  const thin = base();
  thin.sov = { ...thin.sov, Orange: { mentions: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1], negatives: zeros() } };
  const { page, rows } = await load(thin);
  assert.ok(!rows.some((r) => /Orange is louder/.test(r.text)),
    'a rival going from ONE mention to six is not called a trend — the baseline is too thin');
  await page.close();
}
{
  // A 25% gain is not news either; the bar is 25% AND a real baseline.
  const { page, rows } = await load(base({
    sov: { ...base().sov, Orange: { mentions: series(4, 4), negatives: zeros() } },
  }));
  assert.ok(!rows.some((r) => /Orange is louder/.test(r.text)),
    'a rival holding steady is not reported as gaining');
  await page.close();
}
{
  // With a real baseline it IS called out.
  const { page, rows } = await load(base({
    sov: { ...base().sov, Orange: { mentions: series(4, 9), negatives: zeros() } },
  }));
  const o = rows.find((r) => /Orange is louder/.test(r.text));
  assert.ok(o, 'a rival with a real baseline and a real gain is reported');
  assert.match(o.text, /45 mentions in the last 5d vs 20/, 'with both halves stated');
  assert.match(o.href, /^\/\?brand=Orange&win=\d+$/, 'and opens their cards');
  await page.close();
}

/* ── 4. it names WHO and WHERE, and only on a pattern ───────────────────── */
{
  const { page, rows } = await load(base({
    outlets: [
      { outlet: 'Youm7', mentions: 9, negative: 6, neutral: 3, positive: 0, vodNeg: 6, series: zeros() },
      { outlet: 'Al Mal', mentions: 4, negative: 1, neutral: 3, positive: 0, vodNeg: 1, series: zeros() },
    ],
    authors: [
      { author: 'Mona Said', mentions: 5, negative: 4, neutral: 1, positive: 0, vodNeg: 4, outlets: ['Youm7'], series: zeros() },
      { author: 'Ahmed Ali', mentions: 3, negative: 1, neutral: 2, positive: 0, vodNeg: 1, outlets: ['Al Mal'], series: zeros() },
    ],
    narratives: [
      { name: 'Vodafone Cash outages', brand: 'Vodafone', total: 7, negative: 7, neutral: 0, positive: 0, rising: true, ids: [1, 2], idsTotal: 7, series: zeros() },
      { name: 'Orange campaign push', brand: 'Orange', total: 3, negative: 0, neutral: 3, positive: 0, rising: false, ids: [3, 4], idsTotal: 3, series: zeros() },
    ],
  }));
  const outlet = rows.find((r) => /Youm7/.test(r.text));
  assert.ok(outlet, 'the outlet driving the negative coverage is named');
  assert.match(outlet.text, /6 Vodafone-negative of 9/, 'with the ratio, not just the name');
  assert.match(outlet.href, /^\/\?outlet=Youm7&win=\d+$/, 'and opens their coverage');
  // The one-story outlet is NOT named: one negative is an article, not a stance.
  assert.ok(!rows.some((r) => /Al Mal/.test(r.text)), 'an outlet with a single negative is not called a pattern');

  const author = rows.find((r) => /Mona Said/.test(r.text));
  assert.ok(author, 'the most critical byline is named');
  assert.match(author.href, /^\/\?author=Mona%20Said&win=\d+$/, 'and opens their stories');
  assert.ok(!rows.some((r) => /Ahmed Ali/.test(r.text)), 'and a single negative does not qualify a journalist either');

  const narr = rows.find((r) => /still building/.test(r.text));
  assert.ok(narr, 'rising narratives are counted');
  assert.match(narr.text, /1 narrative still building/, 'only the rising ones');
  assert.match(narr.text, /Vodafone Cash outages/, 'and the biggest is named');

  // The category line names a team to hand it to.
  const cat = rows.find((r) => /vodafone cash/i.test(r.text));
  assert.ok(cat, 'the category carrying the most criticism is named');
  assert.match(cat.text, /9 of 20 negatives/, 'as a share of the total, so it can be weighed');
  await page.close();
}

/* ── 5. nothing to say ⇒ it SAYS nothing, out loud ──────────────────────── */
{
  const quiet = base({
    sov: Object.fromEntries(['Vodafone', 'Orange', 'WE', 'e&', 'Market']
      .map((b) => [b, { mentions: zeros(), negatives: zeros() }])),
    categories: [], outlets: [], authors: [], narratives: [],
    totals: { items: 0, negatives: 0, positives: 0, neutrals: 0,
      vodafone: { mentions: 0, negatives: 0 }, distinctOutlets: 0, distinctAuthors: 0, itemsWithByline: 0 },
  });
  DATA = quiet;
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
  await page.goto('http://localhost:8971/stats', { waitUntil: 'networkidle' });
  // An empty window shows the board's own empty state; the strip must not
  // invent five findings from nothing either way.
  const txt = await page.textContent('#content');
  assert.ok(!/leads the negative coverage|is louder|still building/.test(txt),
    'an empty window produces no callouts at all');
  await page.close();
}
{
  // Coverage exists, but nothing clears any bar. The strip must say so rather
  // than reaching for something — a strip that always finds five things is one
  // nobody believes by the second week.
  const flat = base({
    sov: Object.fromEntries(['Vodafone', 'Orange', 'WE', 'e&', 'Market']
      .map((b) => [b, { mentions: series(2, 2), negatives: zeros() }])),
    categories: [{ category: 'corporate', total: 9, negative: 0, vodNeg: 0, series: zeros() }],
    outlets: [{ outlet: 'Al Mal', mentions: 9, negative: 0, neutral: 9, positive: 0, vodNeg: 0, series: zeros() }],
    authors: [], narratives: [],
    totals: { items: 20, negatives: 0, positives: 2, neutrals: 18,
      vodafone: { mentions: 20, negatives: 0 }, distinctOutlets: 3, distinctAuthors: 1, itemsWithByline: 5 },
  });
  const { page, rows, empty } = await load(flat);
  assert.strictEqual(rows.length, 0, 'no line is manufactured from a flat week');
  assert.strictEqual(empty, true, 'and the strip says explicitly that nothing clears the bar');
  assert.match(await page.textContent('.exempty'), /Nothing in this window clears the bar/i,
    'in plain words, so an empty strip reads as an answer rather than a failure');
  await page.close();
}

/* ── 6. no model, and no second aggregation ─────────────────────────────── */
{
  const html = readFileSync(`${DIR}/stats.html`, 'utf8');
  const fn = html.slice(html.indexOf('function execInsights()'), html.indexOf('function execHtml()'));
  // Everything comes off DATA — the same arrays the charts render — so the
  // strip and the card underneath cannot disagree.
  assert.ok(!/fetch\(/.test(fn), 'execInsights makes no request of its own');
  assert.ok(!/anthropic|\bai\b|llm/i.test(fn), 'and involves no model');
  assert.match(fn, /DATA/, 'it reads the payload the page already has');
  // The bars are explicit constants, not emergent from a chain of conditions.
  assert.match(fn, /half>=2/, 'a comparison needs two days a side');
  assert.match(fn, /before<2/, 'a rival needs a real baseline');
  assert.match(fn, /vodNeg>=2/, 'an outlet or author needs a pattern, not one story');
  // The length cap lives in the renderer, not the calculator — so the
  // calculator stays honest about how many findings there are and only the
  // DISPLAY is executive-length.
  const render = html.slice(html.indexOf('function execHtml()'), html.indexOf('function kpiHtml()'));
  assert.match(render, /slice\(0,\s*5\)/, 'at most five lines reach the screen');
}
{
  // At most five lines. An "executive summary" of nine bullets is a report.
  const many = base({
    outlets: Array.from({ length: 6 }, (_, i) => ({ outlet: `Outlet ${i}`, mentions: 9, negative: 5, neutral: 4, positive: 0, vodNeg: 5 - (i % 2), series: zeros() })),
    authors: Array.from({ length: 6 }, (_, i) => ({ author: `Writer ${i}`, mentions: 6, negative: 4, neutral: 2, positive: 0, vodNeg: 4, outlets: ['x'], series: zeros() })),
    narratives: [{ name: 'Thread', brand: 'Vodafone', total: 5, negative: 5, neutral: 0, positive: 0, rising: true, ids: [1, 2], idsTotal: 5, series: zeros() }],
    sov: { ...base().sov, Orange: { mentions: series(4, 9), negatives: zeros() } },
  });
  const { page, rows } = await load(many);
  assert.ok(rows.length <= 5, `the strip stays executive-length (got ${rows.length})`);
  assert.ok(rows.length >= 4, 'while still saying the things that qualify');
  await page.close();
}

/* ── 7. it fits a phone ─────────────────────────────────────────────────── */
{
  const { page } = await load(base({
    outlets: [{ outlet: 'الشروق', mentions: 9, negative: 6, neutral: 3, positive: 0, vodNeg: 6, series: zeros() }],
  }));
  for (const w of [320, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(120);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, `the strip does not pan the page at ${w}px (overflow ${over}px)`);
    const crushed = await page.evaluate(() => [...document.querySelectorAll('.exec, .exec *')]
      .filter((e) => e.scrollWidth > Math.ceil(e.getBoundingClientRect().width) + 1)
      .map((e) => e.className));
    assert.deepStrictEqual(crushed, [], `nothing in the strip is crushed at ${w}px`);
  }
  await page.close();
}

await browser.close();
server.close();
console.log('EXEC-STRIP OK — derived arithmetic only (no request, no model), above the charts; every line carries its numbers and a board link; no percentage against a zero baseline, no comparison without two halves, no "trend" off a one-story outlet; a flat week says so out loud; at most five lines; and it fits 320px');
