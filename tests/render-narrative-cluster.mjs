// Narrative clustering: generic sector words ("four", "mobile") must NOT make
// two unrelated stories one narrative — the exact GEM-tickets + AEON-crypto
// false cluster from production — while genuinely-themed stories still group.
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
console.log(`NARRATIVE-CLUSTER OK — unrelated "four mobile" pair no longer merges; genuine outage pair clusters as "${outage.name}" (${outage.total} stories)`);
