// Trends custom date range, capped at three months.
//
// What this pins, in the order it matters:
//   1. The cap is REFUSED, not clamped. A reader who asks for six months and
//      silently gets ninety days reads the answer as covering six.
//   2. Client validation matches the server's parseCairoRange — same ceiling,
//      same rules — so a range Trends accepts is one /api/stats accepts, and a
//      mistake is answered in place rather than as a 400 after a round trip.
//   3. The window is named by its DATES everywhere, not as "last 43 days".
//   4. Deep links carry from/to, because a custom range cannot be expressed as
//      one of the board's four fixed windows and snapping to the nearest would
//      open a different set of cards than the row counted.
//   5. It does NOT persist. "30 days" means the same thing tomorrow; "1–15 July"
//      does not, and a stale absolute range restored later reads as live data.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const { parseCairoRange } = await import(new URL('..', import.meta.url).pathname + '/lib/report.js');

const series = (m, n) => ({ mentions: m, negatives: n });
const payload = (days) => ({
  meta: { days, generatedAt: new Date().toISOString(), items: 4 },
  days: ['2026-07-01', '2026-07-02'],
  sov: { Vodafone: series([2, 1], [1, 0]), Orange: series([1, 0], [0, 0]), WE: series([0, 0], [0, 0]), 'e&': series([0, 0], [0, 0]), Market: series([0, 0], [0, 0]) },
  sentimentByBrand: { Vodafone: { negative: 1, neutral: 2, positive: 0, total: 3 } },
  categories: [{ category: 'corporate', total: 3, negative: 1, vodNeg: 1, series: [2, 1] }],
  narratives: [],
  outlets: [{ outlet: 'Youm7', mentions: 3, negative: 1, neutral: 2, positive: 0, vodNeg: 1, series: [2, 1] }],
  authors: [{ author: 'Sara', outlets: ['Youm7'], mentions: 3, negative: 1, neutral: 2, positive: 0, vodNeg: 1, series: [2, 1] }],
  totals: { items: 4, negatives: 1, positives: 0, neutrals: 3, vodafone: { mentions: 3, negatives: 1 }, distinctOutlets: 1, distinctAuthors: 1, itemsWithByline: 2 },
});

const seen = [];
const itemQueries = [];
const iso = (d) => new Date(Date.parse(d + 'T09:00:00Z')).toISOString();
const BOARD_ITEMS = [
  { id: 11, brand: 'Vodafone', headline: 'In-range story', summary: 's', sentiment: 'negative', importance: 4, category: 'network', source: 'Youm7', author: null, published_at: iso('2026-07-01'), seen_at: iso('2026-07-01'), is_relevant: true, instances: [] },
  { id: 12, brand: 'Orange', headline: 'Second in-range story', summary: 's', sentiment: 'neutral', importance: 2, category: 'network', source: 'Al Mal', author: null, published_at: iso('2026-07-02'), seen_at: iso('2026-07-02'), is_relevant: true, instances: [] },
];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stats') {
    const q = Object.fromEntries(u.searchParams);
    if (q.view !== 'narratives') seen.push(q);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(q.view === 'narratives' ? { narratives: [] } : payload(q.from ? 2 : Number(q.days) || 30)));
    return;
  }
  if (u.pathname === '/api/items') {
    itemQueries.push(Object.fromEntries(u.searchParams));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(BOARD_ITEMS));
    return;
  }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/stats' ? '/stats.html' : u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8951, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8951/stats', { waitUntil: 'networkidle' });
await page.waitForSelector('.cardc', { timeout: 5000 });

const msg = () => page.$eval('#rMsg', (e) => e.textContent.trim());
const apply = async (from, to) => {
  await page.fill('#rFrom', from); await page.fill('#rTo', to);
  await page.click('#rApply');
  await page.waitForTimeout(120);
};

// ── the control is hidden until asked for, and is a real disclosure ──────────
{
  assert.strictEqual(await page.$eval('#rangeRow', (e) => e.hidden), true, 'the date row starts hidden');
  assert.strictEqual(await page.$eval('#winCustom', (e) => e.getAttribute('aria-expanded')), 'false', 'and says so');
  await page.click('#winCustom');
  assert.strictEqual(await page.$eval('#rangeRow', (e) => e.hidden), false, 'the Custom chip reveals it');
  assert.strictEqual(await page.$eval('#winCustom', (e) => e.getAttribute('aria-expanded')), 'true', 'aria-expanded moves with it');
  // No future dates: there is no coverage there, and empty trailing bars read
  // as a collapse in volume rather than as days that have not happened.
  const max = await page.$eval('#rFrom', (e) => e.max);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(max), `the date inputs cap at today (got ${max})`);
}

// ── 1. the cap REFUSES; it never silently clamps ─────────────────────────────
{
  seen.length = 0;
  await apply('2026-01-01', '2026-07-01');
  const m = await msg();
  assert.ok(/limited to 92/.test(m), `over-long range is refused in place (got "${m}")`);
  assert.strictEqual(seen.length, 0, 'and nothing is requested — a clamped answer would read as covering the whole span');

  // The boundary is exactly where the server puts it, checked against the real
  // parser rather than a number copied into the test.
  const ok92 = '2026-04-01', to92 = new Date(Date.parse(ok92 + 'T00:00:00Z') + 91 * 864e5).toISOString().slice(0, 10);
  assert.strictEqual(parseCairoRange(ok92, to92).days, 92, 'fixture spans exactly the ceiling');
  assert.throws(() => parseCairoRange(ok92, new Date(Date.parse(ok92 + 'T00:00:00Z') + 92 * 864e5).toISOString().slice(0, 10)),
    /limited to 92/, 'and one more day is over it — server side');
}

// ── 2. the other refusals match the server's, and are answered in place ──────
{
  seen.length = 0;
  await apply('2026-07-10', '2026-07-01');
  assert.ok(/before the From/i.test(await msg()), 'reversed dates are refused');
  await apply('', '2026-07-01');
  assert.ok(/Pick both/i.test(await msg()), 'a missing date is refused');
  const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  await apply('2026-07-01', future);
  assert.ok(/future/i.test(await msg()), 'a future end date is refused');
  assert.strictEqual(seen.length, 0, 'none of these reached the server');
}

// ── 3. a valid range loads, and names itself by its dates ────────────────────
{
  seen.length = 0;
  await apply('2026-07-01', '2026-07-02');
  assert.deepStrictEqual(seen.map((q) => [q.from, q.to]), [['2026-07-01', '2026-07-02']],
    `the request carries from/to, not days (got ${JSON.stringify(seen)})`);
  assert.strictEqual(await msg(), '', 'and no error is left on screen');

  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(/2026-07-01 → 2026-07-02/.test(text), 'the window is named by its dates');
  assert.ok(!/last 2 days/.test(text), 'not reduced to a day count the reader did not ask for');

  // The preset chips must not claim to be selected while a range is showing.
  const pressed = await page.$$eval('#winRow .chip[data-v]', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').length);
  assert.strictEqual(pressed, 0, 'no preset reads as selected under a custom range');
  assert.strictEqual(await page.$eval('#winCustom', (e) => e.getAttribute('aria-pressed')), 'true', 'Custom does');

  // 4. deep links carry the dates, so the board shows what the row counted.
  const href = await page.$eval('a.kpi', (a) => a.getAttribute('href'));
  assert.ok(/from=2026-07-01&to=2026-07-02/.test(href), `deep link carries the range (got ${href})`);
  assert.ok(!/win=/.test(href), 'and does NOT snap to a fixed board window');

  // …and the URL reproduces the view on reload / when shared.
  assert.ok(/from=2026-07-01&to=2026-07-02/.test(page.url()), `the URL carries the range (got ${page.url()})`);
}

// ── 5. picking a preset leaves the range cleanly ─────────────────────────────
{
  seen.length = 0;
  await page.click('#winRow .chip[data-v="7"]');
  await page.waitForFunction(() => document.body.innerText.includes('last 7 days'), { timeout: 5000 });
  assert.deepStrictEqual(seen.map((q) => q.days), ['7'], 'the preset requests days again');
  assert.ok(!/from=/.test(page.url()), 'and the range leaves the URL');
  const href = await page.$eval('a.kpi', (a) => a.getAttribute('href'));
  assert.ok(/win=7\b/.test(href) && !/from=/.test(href), `deep links go back to the fixed window (got ${href})`);
}

// ── 6. it does not persist; a fresh visit returns to the preset ──────────────
{
  await page.click('#winCustom');
  await apply('2026-07-01', '2026-07-02');
  await page.goto('http://localhost:8951/stats', { waitUntil: 'networkidle' });
  await page.waitForSelector('.cardc', { timeout: 5000 });
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!/2026-07-01 →/.test(text), 'a fresh visit does not restore a stale absolute range');
  assert.ok(/last 7 days/.test(text), 'it returns to the last preset');
}

// ── 6b. the control is ONE line on a phone ──────────────────────────────────
// It shipped as "FROM [date] TO [date] [Apply]" and broke onto two lines on a
// 390px screen, clipping Apply (user-reported from a screenshot). The FROM/TO
// words cost ~54px; an arrow between the fields says the same thing in 12, and
// the labels stay for a screen reader. The fields share what is left rather
// than each demanding a fixed width, so they shrink together instead of pushing
// the button onto its own line.
{
  await page.click('#winCustom');
  await page.fill('#rFrom', '2026-05-09');
  await page.fill('#rTo', '2026-08-08');   // the longest common rendering

  const measure = () => page.evaluate(() => {
    const row = document.querySelector('#rangeRow');
    const kids = [...row.children].filter((e) => !e.classList.contains('vh') && !e.classList.contains('rmsg'));
    // Count LINES by vertical centre — the controls have different heights, so
    // their `top` values differ even on a single row.
    const lines = new Set(kids.map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.bottom) / 2 / 6); }));
    return {
      lines: lines.size,
      pan: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: kids.filter((e) => e.scrollWidth > Math.ceil(e.getBoundingClientRect().width) + 1).map((e) => e.id || e.className),
      shortest: Math.min(...kids.filter((e) => e.tagName !== 'SPAN').map((e) => Math.round(e.getBoundingClientRect().height))),
      narrowest: Math.min(...kids.filter((e) => e.tagName === 'INPUT').map((e) => Math.round(e.getBoundingClientRect().width))),
      fontPx: parseFloat(getComputedStyle(kids.find((e) => e.tagName === 'INPUT')).fontSize),
    };
  });

  // ONE line at EVERY width, 320 included — it is the narrowest phone anyone
  // uses, and a filter row that reflows there reads as broken.
  for (const w of [320, 360, 390, 430, 768]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(120);
    const m = await measure();
    assert.strictEqual(m.lines, 1, `the range row is one line at ${w}px (got ${m.lines})`);
    assert.strictEqual(m.pan, 0, `and does not pan the page at ${w}px`);
    assert.deepStrictEqual(m.clipped, [], `nothing is clipped at ${w}px`);
    assert.ok(m.shortest >= 28, `every control keeps a usable tap target at ${w}px (shortest ${m.shortest}px)`);
    // A clipped date is a WRONG reading, not a rough one — "9 Mar" and "9 May"
    // truncate alike — so the fields have a floor sized for iOS Safari's long
    // form, which is wider than the numeric one Chromium draws here.
    // The floor tracks the FONT: below 360px the date text drops to 12px, which
    // is what lets the field shrink without truncating "30 Sept 2026". Shrinking
    // the box while keeping 13px text would clip it, and a clipped date is a
    // wrong reading rather than a rough one.
    // A smaller floor is only HONEST if the text shrank with it. Narrowing the
    // box while leaving 13px text is precisely how "30 Sept 2026" gets clipped,
    // and it passes any floor check written as a bare number — so the font is
    // asserted exactly, not as a range.
    const [floor, font] = w < 360 ? [92, 12] : [108, 13];
    assert.strictEqual(m.fontPx, font, `date text is ${font}px at ${w}px (got ${m.fontPx}px) — the floor below assumes it`);
    assert.ok(m.narrowest >= floor, `the date fields keep their floor at ${w}px (need ${floor}, got ${m.narrowest})`);
  }

  // The row says OR, so the dates read as an ALTERNATIVE to the preset chips
  // above rather than a second filter narrowing them. It reuses the WINDOW
  // row's own label style so the two read as one control.
  {
    // Checked for presence FIRST: a bare $eval on a missing node throws
    // "failed to find element matching selector", which tells the next reader
    // nothing about what the row is supposed to contain.
    assert.ok(await page.$('#rangeRow .flabel'),
      'the range row carries an "or" label marking it as an alternative to the preset chips');
    const or = await page.$eval('#rangeRow .flabel', (e) => ({
      text: e.textContent.trim(),
      shown: getComputedStyle(e).textTransform,
      hidden: e.getAttribute('aria-hidden'),
      first: e.parentElement.firstElementChild === e,
    }));
    assert.match(or.text, /^or$/i, `the range row is introduced by "or" (got "${or.text}")`);
    assert.ok(or.first, 'and it leads the row, where the WINDOW label sits on the row above');
    assert.strictEqual(or.shown, 'uppercase', 'styled like the WINDOW label, not as body text');
    // Not aria-hidden: the word is what tells a screen-reader user these are
    // alternatives, not a second filter applied on top of the chips.
    assert.notStrictEqual(or.hidden, 'true', 'a screen reader hears it too');
    const winLabel = await page.$eval('#winRow .flabel', (e) => e.className);
    assert.strictEqual(winLabel, 'flabel', 'the WINDOW row uses the same class, so the two cannot drift apart');
  }

  // The words are HIDDEN, not deleted — this is the bit most likely to be
  // "tidied away" by a later change, and a bare date field tells a screen-reader
  // user nothing about which end of the range it is.
  const labels = await page.$$eval('#rangeRow label', (els) => els.map((e) => ({ htmlFor: e.htmlFor, text: e.textContent.trim(), painted: e.getBoundingClientRect().width > 2 })));
  assert.deepStrictEqual(labels.map((l) => l.htmlFor), ['rFrom', 'rTo'], 'both fields still have a real associated label');
  for (const l of labels) {
    assert.ok(/start|end/i.test(l.text), `the label says which end of the range it is (got "${l.text}")`);
    assert.ok(!l.painted, `and it is visually hidden, not shown (${l.text})`);
  }
  await page.setViewportSize({ width: 1100, height: 1400 });
}

// ── 7. following the deep link: the board honours the range end to end ──────
// The whole point of carrying from/to. If the board ignored them it would show
// its stored default window — a different set of cards than the row counted,
// with nothing on screen saying so.
{
  itemQueries.length = 0;
  await page.goto('http://localhost:8951/?from=2026-07-01&to=2026-07-02', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });
  assert.deepStrictEqual(itemQueries.map((q) => [q.from, q.to, q.days]), [['2026-07-01', '2026-07-02', undefined]],
    `the board asks /api/items for the RANGE, not a day window (got ${JSON.stringify(itemQueries)})`);

  // It must SAY it is showing an unusual window — otherwise the reader assumes
  // their normal Since chip and misreads the volume.
  const banner = await page.$eval('#dfilter', (e) => ({ hidden: e.hidden, text: e.innerText.trim() }));
  assert.strictEqual(banner.hidden, false, 'the deep-link banner is shown for a bare range');
  assert.ok(/2026-07-01/.test(banner.text) && /2026-07-02/.test(banner.text), `the banner names the dates (got "${banner.text}")`);

  // No Since chip may read as selected while a range is showing.
  const pressed = await page.$$eval('#winRow .chip', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').length);
  assert.strictEqual(pressed, 0, 'no Since chip claims to be the active window under a range');

  // Leaving the range REFETCHES — the rows for a fixed window are a different
  // set, not a filter over the ones already loaded.
  itemQueries.length = 0;
  await page.click('#dfilter .dfx');
  await page.waitForFunction(() => document.querySelector('#dfilter').hidden, { timeout: 5000 });
  assert.ok(itemQueries.length >= 1 && itemQueries[0].days && !itemQueries[0].from,
    `clearing the range refetches a normal window (got ${JSON.stringify(itemQueries)})`);
  assert.ok(!/from=/.test(page.url()), 'and drops it from the URL');
}

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('TRENDS-RANGE OK — the 3-month cap refuses rather than clamps, client validation matches parseCairoRange, a valid range names itself by its dates, deep links carry from/to instead of snapping to a fixed board window, presets clear it, and it is never restored from storage');
