// Narrative clustering: generic sector words ("four", "mobile") must NOT make
// two unrelated stories one narrative — the exact GEM-tickets + AEON-crypto
// false cluster from production — while genuinely-themed stories still group.
// Also pins deep-link integrity: a narrative must hand the board an id for
// EVERY story it counts, so "27 stories" never opens as 20 cards.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const now = new Date().toISOString();
const it = (id, category, headline, summary, extra = {}) => ({
  id, brand: 'Vodafone', sentiment: 'neutral', category, importance: 2,
  author: null, source: 'X', published_at: now, seen_at: now, headline, summary, ...extra,
});
// The production false-cluster pair (both category "other"):
const items = [
  it(1, 'other', 'GEM Tickets Made Easy: How to Book Through Vodafone, Orange, WE & e& Egypt Apps',
    'GEM Tickets can now be booked through the mobile apps of all four Egyptian operators: Vodafone, Orange, WE, and e&.', { brand: 'market' }),
  it(2, 'other', "AEON expands AI Agent real-world settlement network, integrating Egypt's four major mobile wallets",
    "AEON's AI settlement network integrates Egypt's four major mobile wallets including Vodafone Cash.", { brand: 'market' }),
  // A genuinely-related pair (same event theme, different wording):
  it(3, 'vodafone_cash', 'Vodafone Cash outage hits transfers nationwide',
    'A Vodafone Cash outage disrupted transfers for users nationwide on Sunday.', { sentiment: 'negative' }),
  it(4, 'vodafone_cash', 'Users report Vodafone Cash outage disrupting transfers',
    'Subscribers reported a Vodafone Cash outage that disrupted transfers across the country.', { sentiment: 'negative' }),
];
// A BIG cluster — 27 stories on one theme, the production shape that exposed
// the deep-link bug: Trends said 27, the board opened 20, and the narrative's
// single negative (last in the cluster, lowest importance) was one of the 7
// dropped. ids must now carry the whole cluster.
for (let i = 0; i < 26; i++) {
  items.push(it(100 + i, 'campaign', `Al Ahly stadium naming rights go to Vodafone (report ${i})`,
    'Vodafone Egypt signs the Al Ahly stadium naming rights sponsorship deal.', { sentiment: 'positive' }));
}
items.push(it(199, 'campaign', 'Fans criticise the Al Ahly stadium naming rights deal with Vodafone',
  'Supporters push back on the Al Ahly stadium naming rights sponsorship deal.', { sentiment: 'negative', importance: 1 }));

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
  if (u.includes('/rest/v1/pr_items')) {
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
    return ok(offset === 0 ? items : []);
  }
  if (u.includes('/rest/v1/pr_instances')) return ok([]);
  return ok([]);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/stats.js');
let code, body;
const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
await handler({ query: { days: '7' }, headers: { authorization: 'Bearer tok' } }, res);
assert.strictEqual(code, 200, 'stats 200');

const narrs = body.narratives || [];
const withIds = (ids) => narrs.find((n) => ids.every((id) => (n.ids || []).includes(id)));
assert.ok(!withIds([1, 2]), `GEM tickets + AEON crypto must NOT be one narrative (got: ${JSON.stringify(narrs.map((n) => ({ name: n.name, ids: n.ids })))})`);
const outage = withIds([3, 4]);
assert.ok(outage, 'the two Vodafone Cash outage stories DO still cluster');
assert.ok(!/\b(mobile|four)\b/i.test(outage.name), 'cluster name avoids generic sector words');
// Deep-link integrity: whatever a narrative row COUNTS, it must hand the board
// enough ids to show. A short list means the board silently displays fewer
// cards than Trends promised — and drops whichever stories fall off the end.
const ahly = narrs.find((n) => (n.ids || []).includes(199));
assert.ok(ahly, 'the 27-story campaign cluster exists and contains its negative outlier');
assert.strictEqual(ahly.total, 27, `cluster totals all 27 stories (got ${ahly.total})`);
assert.strictEqual(ahly.ids.length, ahly.total, `every counted story is deep-linkable (${ahly.ids.length} ids for ${ahly.total} stories)`);
assert.strictEqual(ahly.idsTotal, 27, 'idsTotal reports the true count for the board banner');
assert.strictEqual(ahly.negative, 1, 'the cluster counts its one negative');
for (const n of narrs) {
  assert.ok(n.ids.length === Math.min(n.idsTotal, 100), `${n.name}: ids are complete up to the API cap`);
  assert.strictEqual(new Set(n.ids).size, n.ids.length, `${n.name}: no duplicate ids`);
}

console.log(`NARRATIVE-CLUSTER OK — unrelated "four mobile" pair no longer merges; genuine outage pair clusters as "${outage.name}" (${outage.total} stories); a 27-story cluster deep-links all 27 ids incl. its negative`);
