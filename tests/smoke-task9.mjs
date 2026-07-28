// Task 9 — narrative clustering. Feed a themed set: a "Vodafone Cash outage"
// narrative concentrated in the recent days (should be RISING), a steady
// "roaming price" narrative, and unrelated singletons (should NOT form a
// narrative). Verify grouping, naming, sentiment, and the rising flag.
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const DAY = 864e5;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
let id = 1;
const items = [];
const mk = (o) => items.push({ id: id++, brand: 'Vodafone', importance: 3, is_relevant: true, source: 'Youm7', author: null, ...o });

// Narrative A — "Vodafone Cash outage", 4 stories, all in the last 3 days → rising.
mk({ category: 'vodafone_cash', sentiment: 'negative', headline: 'Vodafone Cash outage hits users across Egypt', summary: 'Vodafone Cash wallet outage leaves users unable to transfer money.', published_at: iso(0), seen_at: iso(0) });
mk({ category: 'vodafone_cash', sentiment: 'negative', headline: 'Vodafone Cash outage spreads, agents frustrated', summary: 'The Vodafone Cash wallet outage widened, agents and users reporting failed transfer attempts.', published_at: iso(1), seen_at: iso(1) });
mk({ category: 'vodafone_cash', sentiment: 'negative', headline: 'Users demand refunds over Vodafone Cash outage', summary: 'Angry users demand refunds after the Vodafone Cash outage.', published_at: iso(1), seen_at: iso(1) });
mk({ category: 'vodafone_cash', sentiment: 'neutral', headline: 'Vodafone responds to Cash outage complaints', summary: 'Vodafone issued a statement on the wallet outage, promising a fix for affected users.', published_at: iso(2), seen_at: iso(2) });

// Narrative B — "roaming price", 3 stories spread across the window (steady, not rising).
mk({ category: 'pricing', brand: 'Orange', sentiment: 'negative', headline: 'Roaming price increase angers travellers', summary: 'A roaming price hike drew backlash from frequent travellers.', published_at: iso(20), seen_at: iso(20) });
mk({ category: 'pricing', brand: 'Orange', sentiment: 'negative', headline: 'Regulator reviews roaming price complaints', summary: 'The regulator is reviewing roaming price complaints from users.', published_at: iso(14), seen_at: iso(14) });
mk({ category: 'pricing', brand: 'Orange', sentiment: 'neutral', headline: 'Operators defend roaming price changes', summary: 'Operators defended the roaming price changes as cost-driven.', published_at: iso(10), seen_at: iso(10) });

// Unrelated singletons — must NOT become narratives.
mk({ category: 'corporate', sentiment: 'positive', headline: 'Vodafone wins network award', summary: 'Vodafone won a national network quality award.', published_at: iso(5), seen_at: iso(5) });
mk({ category: 'campaign', brand: 'WE', sentiment: 'neutral', headline: 'WE launches Ramadan campaign', summary: 'WE launched a new Ramadan advertising campaign.', published_at: iso(6), seen_at: iso(6) });

globalThis.fetch = async (url) => {
  const u = String(url); const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  if (u.includes('/rest/v1/pr_items')) { const off = Number((u.match(/offset=(\d+)/) || [])[1] || 0); return json(off === 0 ? items : []); }
  if (u.includes('/rest/v1/pr_instances')) return json([]);
  throw new Error('unexpected ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/stats.js');
let body; const res = { status: () => res, json: (b) => { body = b; return res; } };
await handler({ query: { days: '30' }, headers: { authorization: 'Bearer tok' } }, res);

const narr = body.narratives;
assert.ok(Array.isArray(narr) && narr.length >= 2, `expected >=2 narratives, got ${narr.length}`);

// The Cash-outage narrative: 4 stories, mostly negative, RISING, named around cash/outage.
const cash = narr.find((n) => /cash|outage/i.test(n.name) || n.category === 'vodafone_cash');
assert.ok(cash, 'cash-outage narrative formed');
assert.strictEqual(cash.total, 4, 'all 4 cash stories grouped');
assert.strictEqual(cash.negative, 3);
assert.strictEqual(cash.brand, 'Vodafone');
assert.ok(cash.rising, 'cash narrative flagged rising (concentrated in recent days)');
assert.ok(/cash|outage/i.test(cash.name), `name mentions the theme: "${cash.name}"`);
assert.strictEqual(cash.series.length, body.days.length, 'series aligned to day axis');
assert.strictEqual(cash.series.reduce((s, v) => s + v, 0), 4, 'series sums to member count');

// The roaming-price narrative: 3 stories, NOT rising (spread across window).
const roam = narr.find((n) => /roaming|price/i.test(n.name) || n.category === 'pricing');
assert.ok(roam, 'roaming-price narrative formed');
assert.strictEqual(roam.total, 3);
assert.ok(!roam.rising, 'steady narrative not flagged rising');

// Singletons did not form narratives.
assert.ok(!narr.find((n) => n.category === 'corporate'), 'award singleton not a narrative');
assert.ok(!narr.find((n) => n.category === 'campaign'), 'campaign singleton not a narrative');

// Rising sorts first.
assert.ok(narr[0].rising, 'rising narrative sorted to the top');

writeFileSync(new URL('./out/', import.meta.url).pathname + 'stats9-fixture.json', JSON.stringify(body));
console.log('ALL TASK 9 TESTS PASSED — narratives:', narr.map((n) => `"${n.name}"${n.rising ? ' (rising)' : ''} x${n.total}`).join(', '));
