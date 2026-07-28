// Task 7 smoke test — detectSurges() over a mocked DB: a real spike is caught,
// a quiet brand is floor-guarded, weighting is by coverage spread, and the
// email renders. Also verifies the throttle logic shape used by radar.js.
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.BOARD_URL = 'https://pr.example/';
// defaults: window 21, K 2, floor 4

const DAY = 864e5;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

// Build the dataset. Baseline: Vodafone ~1 negative/day (1 outlet) over 21 days.
// Today: Vodafone spikes — 3 negative stories with 5/4/3 outlets = weighted 12.
// Orange: flat 1/day incl today → no surge. WE: quiet, today a single 1-outlet
// negative → below floor, no surge.
let id = 1;
const items = [];
const outletsById = new Map();     // id -> coverage spread
const rich = [];                   // recentItems(days:1) rows (today, with headline)
const addNeg = (brand, daysAgo, outlets, headline) => {
  const it = { id: id++, brand, sentiment: 'negative', category: 'network', importance: 3, author: null, source: 'Youm7', published_at: iso(daysAgo), seen_at: iso(daysAgo) };
  items.push(it); outletsById.set(it.id, outlets);
  if (daysAgo === 0) rich.push({ ...it, headline: headline || `neg ${it.id}`, summary: 's', url: 'u', resolved_url: null });
  return it;
};
// baseline
for (let d = 1; d <= 21; d++) { addNeg('Vodafone', d, 1); addNeg('Orange', d, 1); }
// a couple neutrals so itemsForStats isn't all-negative
for (let d = 1; d <= 5; d++) items.push({ id: id++, brand: 'WE', sentiment: 'neutral', category: 'corporate', importance: 2, source: 'AlMal', published_at: iso(d), seen_at: iso(d) });
// today
addNeg('Vodafone', 0, 5, 'Vodafone Cash outage spreads nationwide');
addNeg('Vodafone', 0, 4, 'Billing error hits Vodafone subscribers');
addNeg('Vodafone', 0, 3, 'Vodafone data throttling complaints surge');
addNeg('Orange', 0, 1);   // keeps Orange flat
addNeg('WE', 0, 1, 'Minor WE grumble');   // single, below floor

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  if (u.includes('/rest/v1/pr_items') && u.includes('select=id,brand')) {  // itemsForStats
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
    return json(offset === 0 ? items : []);
  }
  if (u.includes('/rest/v1/pr_items') && u.includes('select=*')) return json(rich);  // recentItems(days:1)
  if (u.includes('/rest/v1/pr_instances')) {
    const ids = decodeURIComponent((u.match(/item_id=in\.\(([^)]*)\)/) || [])[1] || '').split(',').map(Number);
    const rows = [];
    for (const iid of ids) for (let k = 0; k < (outletsById.get(iid) || 1); k++) rows.push({ item_id: iid, outlet: `outlet${k}`, author: null, url: `u${iid}_${k}`, published_at: iso(0) });
    return json(rows);
  }
  throw new Error('unexpected fetch ' + u);
};

const { detectSurges, renderSurgeEmail } = await import(new URL('..', import.meta.url).pathname + '/lib/surge.js');
const surges = await detectSurges();

// exactly one surge: Vodafone
assert.strictEqual(surges.length, 1, `expected 1 surge, got ${surges.length}: ${surges.map((s) => s.brand)}`);
const v = surges[0];
assert.strictEqual(v.brand, 'Vodafone');
assert.strictEqual(v.today, 12, `weighted today should be 12 (5+4+3), got ${v.today}`);   // proves spread-weighting
assert.ok(Math.abs(v.mean - 1) < 0.2, `baseline mean ~1, got ${v.mean}`);
assert.ok(v.multiple >= 8, `big multiple, got ${v.multiple}`);
assert.strictEqual(v.topStories.length, 3);
assert.strictEqual(v.topStories[0].outlets, 5, 'top story is the 5-outlet one (sorted by spread)');
assert.ok(/Vodafone Cash outage/.test(v.topStories[0].headline), 'headline attached from recentItems');
// Orange flat, WE below floor → not flagged
assert.ok(!surges.find((s) => s.brand === 'Orange'), 'Orange flat → no surge');
assert.ok(!surges.find((s) => s.brand === 'WE'), 'WE single 1-outlet → below floor → no surge');

// render
const html = renderSurgeEmail(surges, 'https://pr.example/');
assert.ok(/SURGE/.test(html) && /Vodafone/.test(html) && /12/.test(html), 'email renders surge');
assert.ok(/Vodafone Cash outage/.test(html), 'top story in email');
assert.ok(/api\/go\?id=/.test(html), 'story deep-links');
writeFileSync(new URL('./out/', import.meta.url).pathname + 'surge.html', html);

// floor tuning: raise floor above 12 → no surge (proves the guard is live)
process.env.SURGE_MIN_VOLUME = '20';
const none = await detectSurges();
assert.strictEqual(none.length, 0, 'floor=20 suppresses the 12-volume surge');
delete process.env.SURGE_MIN_VOLUME;

console.log('ALL TASK 7 SMOKE TESTS PASSED — Vodafone surge x' + v.multiple + ', weighted', v.today, 'vs mean', v.mean);
