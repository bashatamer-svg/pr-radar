// Task 8 — stats API now emits per-outlet/author sentiment split + activity
// series + flags. Verify shape + reconciliation, write a fixture for the render.
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const DAY = 864e5;
const iso = (d) => new Date(Date.now() - d * DAY + 10 * 36e5 - 10 * 36e5).toISOString();
const items = [];
let id = 1;
const mk = (brand, sentiment, daysAgo, author, source) => items.push({
  id: id++, brand, sentiment, category: 'network', importance: sentiment === 'negative' ? 4 : 2,
  author: author || null, source, published_at: iso(daysAgo), seen_at: iso(daysAgo),
});
// A repeat-critic author (2+ Vodafone-negative) at Youm7, spread over days
for (let d = 0; d < 6; d++) mk('Vodafone', d % 2 ? 'negative' : 'neutral', d, 'Ahmed Salah', 'Youm7');
// A positive-leaning author
for (let d = 0; d < 4; d++) mk('Orange', 'positive', d, 'Sara Adel', 'Daily News Egypt');
// A negative-leaning outlet with no bylines
for (let d = 0; d < 5; d++) mk('Vodafone', 'negative', d, null, 'Masrawy');
// neutral filler
for (let d = 0; d < 3; d++) mk('WE', 'neutral', d, null, 'Al Mal');

globalThis.fetch = async (url) => {
  const u = String(url); const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  if (u.includes('/rest/v1/pr_items')) { const off = Number((u.match(/offset=(\d+)/) || [])[1] || 0); return json(off === 0 ? items : []); }
  if (u.includes('/rest/v1/pr_instances')) return json([]);   // fall back to items' own source/author
  throw new Error('unexpected ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/stats.js');
let body; const res = { status: () => res, json: (b) => { body = b; return res; } };
await handler({ query: { days: '30' }, headers: { authorization: 'Bearer tok' } }, res);

// every outlet/author row now carries the sentiment split + a series array
for (const o of body.outlets) {
  for (const k of ['negative', 'neutral', 'positive', 'series']) assert.ok(k in o, `outlet missing ${k}`);
  assert.strictEqual(o.negative + o.neutral + o.positive, o.mentions, `outlet ${o.outlet} sentiment sums to mentions`);
  assert.strictEqual(o.series.length, body.days.length, 'series aligned to day axis');
}
for (const a of body.authors) {
  for (const k of ['negative', 'neutral', 'positive', 'series']) assert.ok(k in a, `author missing ${k}`);
  assert.strictEqual(a.negative + a.neutral + a.positive, a.mentions, `author ${a.author} sentiment sums to mentions`);
}

// Ahmed Salah is a repeat critic (3 Vodafone-negative over the 6 days)
const ahmed = body.authors.find((a) => a.author === 'Ahmed Salah');
assert.ok(ahmed && ahmed.vodNeg >= 2, 'Ahmed flagged repeat-critic-eligible');
assert.strictEqual(ahmed.negative, 3);
assert.ok(ahmed.series.some((v) => v > 0), 'Ahmed has activity in the series');
// Sara Adel positive
const sara = body.authors.find((a) => a.author === 'Sara Adel');
assert.strictEqual(sara.positive, 4);
assert.strictEqual(sara.negative, 0);
// Masrawy negative-leaning outlet
const masrawy = body.outlets.find((o) => o.outlet === 'Masrawy');
assert.ok(masrawy.negative / masrawy.mentions >= 0.5, 'Masrawy majority-negative');

writeFileSync(new URL('./out/', import.meta.url).pathname + 'stats8-fixture.json', JSON.stringify(body));
console.log('ALL TASK 8 API TESTS PASSED —', body.outlets.length, 'outlets,', body.authors.length, 'authors, series aligned');
