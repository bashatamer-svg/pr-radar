// The per-day axis must span the window the ITEMS came from.
//
// itemsForStats cuts at `now - N*864e5` — a rolling instant — so every window
// opens PART-WAY through a Cairo day. The axis used to be built as "the last N
// calendar days ending today", which does not contain that opening day: items
// landing in it were counted in every total (KPIs, sentiment split,
// leaderboards) and then dropped from the per-day series, because
// `dayIdx.get(dayOf(it))` came back undefined. The charts quietly disagreed
// with the numbers printed above them.
//
// One bar in thirty-one at the month window. HALF THE CHART at 24 hours: at
// 14:00 Cairo the axis held only today, so everything between 14:00 yesterday
// and midnight was in the totals and absent from the bars.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.CRON_SECRET = 'cron';
delete process.env.ANTHROPIC_API_KEY;   // stage-1 clustering only; no model here

const cairoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Every item sits INSIDE a rolling 24h window, but straddles Cairo midnight:
// some this morning, some yesterday evening. Both halves are real coverage.
const now = Date.now();
const at = (hoursAgo) => new Date(now - hoursAgo * 36e5).toISOString();
const ITEMS = [
  { id: 1, brand: 'Vodafone', sentiment: 'negative', category: 'network', importance: 4, source: 'Youm7', author: null, headline: 'a', summary: 'a', published_at: at(1),  seen_at: at(1),  is_relevant: true },
  { id: 2, brand: 'Vodafone', sentiment: 'negative', category: 'network', importance: 3, source: 'Youm7', author: null, headline: 'b', summary: 'b', published_at: at(4),  seen_at: at(4),  is_relevant: true },
  { id: 3, brand: 'Orange',   sentiment: 'neutral',  category: 'network', importance: 2, source: 'Al Mal', author: null, headline: 'c', summary: 'c', published_at: at(20), seen_at: at(20), is_relevant: true },
  { id: 4, brand: 'Vodafone', sentiment: 'positive', category: 'brand',   importance: 2, source: 'Al Mal', author: null, headline: 'd', summary: 'd', published_at: at(23), seen_at: at(23), is_relevant: true },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('pr_items')) return { ok: true, status: 200, text: async () => JSON.stringify(ITEMS) };
  return { ok: true, status: 200, text: async () => '[]' };
};

const { default: stats } = await import('../api/stats.js');
const call = async (query) => {
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end: () => res };
  await stats({ method: 'GET', query, headers: { authorization: 'Bearer cron' } }, res);
  return { code, body };
};

// Every distinct Cairo day the fixture actually occupies.
const occupied = [...new Set(ITEMS.map((i) => cairoDay.format(new Date(i.published_at))))];

for (const days of ['1', '2', '7', '30']) {
  const { code, body } = await call({ days });
  assert.strictEqual(code, 200, `days=${days} responds`);
  const { days: axis, sov, totals } = body;

  // 1. The axis covers every day the window's items land on. Without this the
  //    series silently omit them.
  for (const d of occupied) {
    assert.ok(axis.includes(d),
      `days=${days}: the axis must contain ${d}, a Cairo day this window's items occupy (axis: ${axis[0]}..${axis[axis.length - 1]}, ${axis.length} buckets)`);
  }

  // 2. …and the consequence that actually bit: what the bars add up to must
  //    equal what the KPI row claims. These are computed in the same pass, so a
  //    mismatch means items fell off the axis.
  const plotted = Object.values(sov).reduce((s, b) => s + b.mentions.reduce((x, y) => x + y, 0), 0);
  assert.strictEqual(plotted, totals.items,
    `days=${days}: the per-day series must plot every item the totals count (plotted ${plotted}, totals ${totals.items})`);

  const plottedNeg = Object.values(sov).reduce((s, b) => s + b.negatives.reduce((x, y) => x + y, 0), 0);
  assert.strictEqual(plottedNeg, totals.negatives,
    `days=${days}: negatives must reconcile too (plotted ${plottedNeg}, totals ${totals.negatives})`);

  // 3. Every series is the same length as the axis, or the chart reads the
  //    wrong value under the wrong date.
  for (const [brand, s] of Object.entries(sov)) {
    assert.strictEqual(s.mentions.length, axis.length, `days=${days}: ${brand} mentions series matches the axis length`);
    assert.strictEqual(s.negatives.length, axis.length, `days=${days}: ${brand} negatives series matches the axis length`);
  }

  // 4. The axis is ordered oldest → newest and has no repeats (a 24h hop across
  //    a DST change can emit the same local day twice).
  assert.deepStrictEqual(axis, [...axis].sort(), `days=${days}: axis runs oldest to newest`);
  assert.strictEqual(new Set(axis).size, axis.length, `days=${days}: no duplicate day on the axis`);
}

// The 24-hour window is the one where this was severe: a rolling day straddles
// Cairo midnight, so the axis must carry MORE than a single bucket whenever the
// items do. (Exactly at midnight one bucket is correct, hence the guard.)
{
  const { body } = await call({ days: '1' });
  if (occupied.length > 1) {
    assert.ok(body.days.length >= 2,
      `a rolling 24h window spanning two Cairo days needs both buckets (got ${body.days.length}: ${body.days.join(', ')})`);
  }
  assert.strictEqual(body.meta.days, 1, 'meta still reports the window it was asked for');
}

console.log('STATS-AXIS OK — the per-day axis spans the rolling window it was cut from, so the bars plot every item the totals count (checked at 1/2/7/30 days, series lengths, ordering and de-duplication)');
