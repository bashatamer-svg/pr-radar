// Task 3 smoke test — api/stats.js aggregation with a mocked Supabase REST.
// Verifies auth, shape, reconciliation (totals match input rows), leaderboard
// dedupe, and writes the JSON out as a fixture for the browser render test.
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const iso = (daysAgo, h = 10) => new Date(Date.now() - daysAgo * 864e5 + h * 36e5 - 10 * 36e5).toISOString();

// 40 items over ~20 days: mixed brands/sentiments/categories.
const items = [];
let id = 1;
const mk = (brand, sentiment, category, daysAgo, author, source) => items.push({
  id: id++, brand, sentiment, category, importance: sentiment === 'negative' ? 4 : 2,
  author: author || null, source, published_at: iso(daysAgo), seen_at: iso(daysAgo),
});
for (let d = 0; d < 10; d++) {
  mk('Vodafone', d % 3 === 0 ? 'negative' : 'neutral', d % 2 ? 'network' : 'vodafone_cash', d, d % 4 === 0 ? 'Ahmed Salah' : null, 'Youm7');
  mk('Orange', d % 4 === 0 ? 'positive' : 'neutral', 'campaign', d, null, 'Daily News Egypt');
}
for (let d = 0; d < 8; d++) mk('WE', 'neutral', 'corporate', d * 2, 'Sara Adel', 'Al Mal');
for (let d = 0; d < 7; d++) mk(d % 2 ? 'e&' : null, d % 2 ? 'negative' : 'neutral', 'pricing', d, null, 'Masrawy');
for (let d = 0; d < 5; d++) mk('Vodafone', 'negative', 'customer_service', d + 3, 'Ahmed Salah', 'Youm7');

// instances: first Vodafone item ran in 3 outlets (one duplicated → dedupe test)
const instances = [
  { item_id: 1, outlet: 'Youm7', author: 'Ahmed Salah', url: 'u1', published_at: iso(0) },
  { item_id: 1, outlet: 'Masrawy', author: null, url: 'u2', published_at: iso(0) },
  { item_id: 1, outlet: 'Masrawy', author: null, url: 'u2b', published_at: iso(0) }, // same outlet twice → counts once
  { item_id: 1, outlet: 'Al Ahram', author: 'Mona Zaki', url: 'u3', published_at: iso(0) },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (data) => ({ ok: true, text: async () => JSON.stringify(data) });
  if (u.includes('/rest/v1/pr_items')) {
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
    return json(offset === 0 ? items : []);
  }
  if (u.includes('/rest/v1/pr_instances')) {
    const idList = decodeURIComponent((u.match(/item_id=in\.\(([^)]*)\)/) || [])[1] || '').split(',').map(Number);
    return json(instances.filter((r) => idList.includes(r.item_id)));
  }
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/stats.js');
const call = async (query, headers = { authorization: 'Bearer tok' }) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; } };
  await handler({ query, headers }, res);
  return { code, body };
};

// auth
assert.strictEqual((await call({}, { authorization: 'Bearer wrong' })).code, 401);

const { code, body } = await call({ days: '30' });
assert.strictEqual(code, 200);

// reconciliation: totals match the raw rows exactly
assert.strictEqual(body.totals.items, items.length);
const negIn = items.filter((i) => i.sentiment === 'negative').length;
assert.strictEqual(body.totals.negatives, negIn);
const vodIn = items.filter((i) => i.brand === 'Vodafone');
assert.strictEqual(body.totals.vodafone.mentions, vodIn.length);
assert.strictEqual(body.totals.vodafone.negatives, vodIn.filter((i) => i.sentiment === 'negative').length);

// sentimentByBrand sums back to the total; null brand landed in Market
const sentSum = Object.values(body.sentimentByBrand).reduce((s, b) => s + b.total, 0);
assert.strictEqual(sentSum, items.length);
assert.ok(body.sentimentByBrand.Market.total >= items.filter((i) => !i.brand).length);

// sov day arrays are aligned with days and sum to ≤ items (Cairo-edge clamp)
assert.strictEqual(body.days.length, 30);
for (const b of ['Vodafone', 'Orange', 'WE', 'e&', 'Market']) {
  assert.strictEqual(body.sov[b].mentions.length, 30);
  assert.strictEqual(body.sov[b].negatives.length, 30);
}
const sovSum = Object.values(body.sov).reduce((s, b) => s + b.mentions.reduce((a, v) => a + v, 0), 0);
assert.ok(sovSum <= items.length && sovSum >= items.length - 2, `sov ${sovSum} ≈ ${items.length}`);

// categories sorted by volume, series aligned
assert.ok(body.categories.length >= 4);
assert.ok(body.categories[0].total >= body.categories[body.categories.length - 1].total);

// outlet dedupe: item 1 counts Masrawy ONCE despite two instance rows
const masrawy = body.outlets.find((o) => o.outlet === 'Masrawy');
const masrawyExpected = items.filter((i) => i.source === 'Masrawy' && i.id !== 1).length + 1;
assert.strictEqual(masrawy.mentions, masrawyExpected);

// authors present, no outlet-as-author leakage
assert.ok(body.authors.find((a) => a.author === 'Ahmed Salah'));
assert.ok(!body.authors.find((a) => a.author.toLowerCase() === 'youm7'));

// days clamp
assert.strictEqual((await call({ days: '900' })).body.meta.days, 90);
assert.strictEqual((await call({ days: '0' })).body.meta.days, 30);

writeFileSync(new URL('./out/', import.meta.url).pathname + 'stats-fixture.json', JSON.stringify(body));
console.log('ALL TASK 3 API SMOKE TESTS PASSED —', body.totals.items, 'items,', body.outlets.length, 'outlets,', body.authors.length, 'authors');
