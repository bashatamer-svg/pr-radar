// The Sort control has to survive scrolling.
//
// It used to live in `.bar2` alongside Show and Since. `.bar2` WAS sticky, but
// it stacks four rows — status, Show, Since, Sort — so pinned under the 92px
// header it held roughly 250px of a 390px phone's viewport permanently. A third
// of the screen spent on controls while reading cards, and in practice the one
// control you actually want mid-scroll (re-order what I am looking at) was the
// one at the bottom of that stack.
//
// So: Sort moves into its own slim pinned bar, and `.bar2` stops pinning.
// Show and Since are set-once filters you scroll past; Sort is not.
//
// The bar also carries the LANE you are currently reading, because pinning a
// bar over the list hides the `.sechead` that says which lane a card belongs to
// — and a fix that costs you the lane heading is not a fix. It mirrors the
// headings already in the list; it never invents one.
//
// What this pins:
//   1. Sort is in the pinned bar, not in .bar2, and .bar2 no longer sticks
//   2. the chips are still on screen after scrolling to the bottom of the list
//   3. the lane label tracks whichever .sechead has scrolled under the bar
//   4. it survives the Newest mode, where the three lanes collapse to one
//   5. re-ordering from deep in the list returns you to the top of the list
//   6. 320/360/390: no document pan, and the chips never shrink below a tap
//      target — the label yields instead, because the same label is inline in
//      the list two lines away while a shrunken chip cannot be tapped
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// Enough cards in all three lanes that the list is taller than any viewport
// here — the whole point is behaviour AFTER scrolling.
const items = [];
let id = 1;
const push = (brand, sentiment, importance, n) => {
  for (let i = 0; i < n; i++) {
    items.push({ id: id++, brand, sentiment, importance,
      headline: `${brand} ${sentiment} story number ${i} with a reasonably long headline`,
      summary: 'A summary long enough to give the card real height on screen.',
      category: 'network', url: `u${id}`, resolved_url: `u${id}`,
      published_at: H(i + 1), instances: [] });
  }
};
push('Vodafone', 'negative', 4, 6);   // Needs a response
push('Vodafone', 'positive', 3, 6);   // Wins to amplify
push('Orange', 'neutral', 2, 6);      // Market & noted

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try {
    const b = readFileSync(DIR + f);
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8987, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const open = async (w = 900, h = 900) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
  await page.goto('http://localhost:8987/?win=30', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 5000 });
  return { page, errs };
};

/* ── 1. structure: Sort moved out, and .bar2 stopped pinning ─────────────── */
{
  const { page, errs } = await open();
  const where = await page.evaluate(() => ({
    sortInBar2: !!document.querySelector('#bar2 #sortRow'),
    sortInSortbar: !!document.querySelector('#sortbar #sortRow'),
    bar2Pos: getComputedStyle(document.querySelector('#bar2')).position,
    barPos: getComputedStyle(document.querySelector('#sortbar')).position,
    barTop: getComputedStyle(document.querySelector('#sortbar')).top,
    headerH: getComputedStyle(document.documentElement).getPropertyValue('--mh').trim(),
  }));
  assert.strictEqual(where.sortInBar2, false, 'Sort no longer sits in the four-row filter block');
  assert.strictEqual(where.sortInSortbar, true, 'it lives in the slim pinned bar');
  assert.strictEqual(where.bar2Pos, 'static',
    '.bar2 no longer pins — status/Show/Since are set-once filters, and pinned they cost a third of a phone viewport');
  assert.strictEqual(where.barPos, 'sticky', 'the sort bar pins');
  assert.strictEqual(where.barTop, where.headerH,
    `and pins directly under the header (top ${where.barTop} vs --mh ${where.headerH})`);
  assert.deepStrictEqual(errs, [], 'no page errors');
  await page.close();
}

/* ── 2. THE ACTUAL ASK: still reachable at the bottom of the list ────────── */
{
  const { page } = await open();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(120);
  const vis = await page.evaluate(() => {
    const c = document.querySelector('#sortRow .chip[data-sort="newest"]');
    const r = c.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: innerHeight, scrolled: window.scrollY };
  });
  assert.ok(vis.scrolled > 300, `the page really scrolled (${vis.scrolled}px)`);
  assert.ok(vis.top >= 0 && vis.bottom <= vis.h,
    `the sort chips are still on screen at the bottom of the list (top ${vis.top}, bottom ${vis.bottom}, viewport ${vis.h})`);
  // And .bar2 is gone from view, which is what buys the room.
  const bar2 = await page.evaluate(() => document.querySelector('#bar2').getBoundingClientRect().bottom);
  assert.ok(bar2 < 0, `the filter block scrolled away rather than staying pinned (bottom ${bar2})`);
  await page.close();
}

/* ── 3. the lane label mirrors the heading you are reading ───────────────── */
{
  const { page } = await open();
  const laneText = () => page.$eval('#sbLane', (e) => e.textContent.replace(/\s+/g, ' ').trim());

  // NOT DUPLICATED. The bar exists to replace a heading the pinning covered up,
  // so while the real heading is still on screen the bar must say nothing —
  // otherwise "Needs a response 1" appears twice, one line apart, which is what
  // shipped first and read as a rendering bug.
  assert.strictEqual(await laneText(), '',
    'at the top the bar is silent — the real heading is right there below it');
  // The invariant, checked at every scroll position below: whatever the bar
  // says must NOT also be legible in the list at that moment.
  const dupes = () => page.evaluate(() => {
    const lane = document.querySelector('#sbLane').textContent.replace(/\s+/g, ' ').trim();
    if (!lane) return [];
    const barBottom = document.querySelector('#sortbar').getBoundingClientRect().bottom;
    return [...document.querySelectorAll('#list .sechead')]
      // Visible means below the pinned bar, not merely inside the viewport — a
      // heading tucked under the bar is covered up, which is the whole reason
      // the label exists.
      .filter((h) => { const r = h.getBoundingClientRect(); return r.top >= barBottom - 1 && r.top < innerHeight; })
      .map((h) => h.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t === lane);
  });
  assert.deepStrictEqual(await dupes(), [], 'and never repeats a heading that is visible in the list');

  // Scroll so the Wins heading is under the bar.
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('#list .sechead')].find((x) => /Wins/.test(x.textContent));
    window.scrollTo(0, window.scrollY + h.getBoundingClientRect().top - 10);
  });
  await page.waitForTimeout(150);
  assert.match(await laneText(), /Wins to amplify/,
    'scrolling into the Wins lane updates the pinned label — otherwise the bar hides the only thing that says which lane a card is in');
  assert.deepStrictEqual(await dupes(), [], 'and the heading it names is the one now hidden under the bar');

  await page.evaluate(() => {
    const h = [...document.querySelectorAll('#list .sechead')].find((x) => /Market/.test(x.textContent));
    window.scrollTo(0, window.scrollY + h.getBoundingClientRect().top - 10);
  });
  await page.waitForTimeout(150);
  assert.match(await laneText(), /Market & noted/, 'and again for the third lane');
  assert.deepStrictEqual(await dupes(), [], 'still no visible duplicate');

  // It MIRRORS, never invents: every label it can show is a heading in the list.
  const inList = await page.$$eval('#list .sechead .lab', (els) => els.map((e) => e.textContent.trim()));
  const shown = (await laneText()).replace(/\d+$/, '').trim();
  assert.ok(inList.some((l) => shown.includes(l)), `"${shown}" is one of the list's own headings`);

  // Not announced: it restates a heading that is already in the DOM, and a
  // label that re-announced on every scroll tick is how a reader turns
  // announcements off.
  assert.strictEqual(await page.$eval('#sbLane', (e) => e.getAttribute('aria-hidden')), 'true',
    'the mirrored label is aria-hidden — the real headings are still in the list');
  await page.close();
}

/* ── 4. Newest mode: lanes collapse, the bar survives ────────────────────── */
// This is the case that killed the obvious design — putting Sort inside a lane
// header means choosing Newest deletes the control's own container.
{
  const { page, errs } = await open();
  await page.click('#sortRow .chip[data-sort="newest"]');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.$$eval('#list .sechead', (e) => e.length), 1,
    'Newest collapses the three lanes to one heading');
  assert.ok(await page.$('#sortbar #sortRow .chip[data-sort="impact"]'),
    'and the sort control is still there to switch back with');
  // Same rule as the lanes: silent while the real heading is on screen, and it
  // takes over once that heading scrolls under the bar.
  assert.strictEqual(await page.$eval('#sbLane', (e) => e.textContent.trim()), '',
    'silent at the top, where the flat heading is visible');
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(150);
  assert.match(await page.$eval('#sbLane', (e) => e.textContent), /Newest first/,
    'and the pinned label follows into the flat mode once the heading is covered');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.click('#sortRow .chip[data-sort="impact"]');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.$$eval('#list .sechead', (e) => e.length), 3, 'and back again');
  assert.deepStrictEqual(errs, [], 'no page errors across the switch');
  await page.close();
}

/* ── 5. re-ordering from deep in the list returns you to its top ─────────── */
// New consequence of a pinned control: you can now sort from anywhere. Leaving
// the scroll position alone would leave you staring at unrelated cards in a new
// order, which reads as the control having done nothing.
{
  const { page } = await open();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(120);
  await page.click('#sortRow .chip[data-sort="newest"]');
  await page.waitForTimeout(200);
  const pos = await page.evaluate(() => {
    const l = document.querySelector('#list').getBoundingClientRect();
    const bar = document.querySelector('#sortbar').getBoundingClientRect();
    const first = document.querySelector('.card').getBoundingClientRect();
    return { listTop: l.top, barBottom: bar.bottom, firstTop: first.top, firstBottom: first.bottom, h: innerHeight };
  });
  assert.ok(pos.listTop >= pos.barBottom - 2,
    `the list top is back under the bar rather than left mid-scroll (list ${pos.listTop}, bar ${pos.barBottom})`);
  assert.ok(pos.firstBottom > pos.barBottom && pos.firstTop < pos.h,
    'and the first card is visible, not hidden behind the pinned bar');
  await page.close();
}

/* ── 6. phones: no pan, and the chips never shrink ───────────────────────── */
for (const w of [320, 360, 390]) {
  const { page, errs } = await open(w, 800);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(120);
  const m = await page.evaluate(() => {
    const bar = document.querySelector('#sortbar');
    const row = document.querySelector('#sortRow');
    const chips = [...document.querySelectorAll('#sortRow .chip')].map((c) => {
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height, text: c.textContent.trim() };
    });
    const lane = document.querySelector('#sbLane');
    return {
      pan: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      barCrush: bar.scrollWidth - Math.ceil(bar.getBoundingClientRect().width),
      rowOverflow: row.scrollWidth - row.clientWidth,
      chips,
      laneShown: getComputedStyle(lane).display !== 'none',
      barBottom: bar.getBoundingClientRect().bottom,
      chipTop: chips.length ? document.querySelector('#sortRow .chip').getBoundingClientRect().top : 0,
    };
  });
  assert.ok(m.pan <= 1, `${w}px: the page does not pan sideways (overflow ${m.pan}px)`);
  assert.ok(m.barCrush <= 1, `${w}px: nothing in the bar is crushed (${m.barCrush}px)`);
  assert.ok(m.rowOverflow <= 1, `${w}px: the two chips fit without scrolling (${m.rowOverflow}px)`);
  for (const c of m.chips) {
    // The rule from the card-footer and leaderboard fixes: a control whose size
    // is part of its usability does not shrink. The label yields instead.
    // 28px, matching the floor render-board-sort already set for these exact
    // chips. The bar was slimmed by taking height out of its OWN padding, not
    // out of the controls — a control whose size is part of its usability does
    // not get shrunk to buy layout (the card-footer Gotcha).
    assert.ok(c.h >= 28, `${w}px: chip "${c.text}" keeps a tappable height (${c.h}px)`);
    assert.ok(c.w >= 60, `${w}px: chip "${c.text}" is not squeezed (${c.w}px)`);
  }
  // Below 380 the label is the child that goes — its function is reachable,
  // the same heading is inline in the list. Above it, it is shown.
  assert.strictEqual(m.laneShown, w >= 380,
    `${w}px: the lane label is ${w >= 380 ? 'shown' : 'hidden so the chips keep their size'}`);
  assert.deepStrictEqual(errs, [], `${w}px: no page errors`);
  await page.close();
}

await browser.close();
server.close();
console.log('STICKY-SORT OK — Sort moved out of the four-row filter block into its own pinned bar and .bar2 stopped sticking, so the chips are still on screen at the bottom of the list while the set-once filters scroll away; the bar carries the lane you are reading (mirrored from the list\'s own headings, aria-hidden, never invented), survives the Newest collapse that would have deleted a lane-header-hosted control, returns you to the top of the list after a re-order, and at 320/360/390 the page never pans and the chips never shrink — the label yields instead');
