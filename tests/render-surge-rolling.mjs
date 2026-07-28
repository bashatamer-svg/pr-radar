// Task 6 — rolling trailing-24h surge window. A spike that straddles the Cairo
// midnight boundary is DILUTED by the partial calendar day (calendar-day misses
// it) but fully captured by the trailing 24h (rolling-24h catches it). Default
// stays calendar-day; SURGE_ROLLING=1 promotes rolling. Fixed clock → deterministic.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.BOARD_URL = 'https://pr.example/';
// defaults: window 21, K 2, floor 4

// Freeze "now" at 01:00 UTC → Cairo 03:00 (UTC+2) or 04:00 (UTC+3, DST): early
// in the Cairo day either way, so items >4h old fall in "yesterday".
const FIXED = Date.parse('2026-07-15T01:00:00Z');
const realNow = Date.now;
Date.now = () => FIXED;
const H = 3600e3, DAY = 864e5;
const isoH = (hoursAgo) => new Date(FIXED - hoursAgo * H).toISOString();

let id = 1;
const items = [];
const outletsById = new Map();
const rich = [];
const addNeg = (brand, hoursAgo, outlets = 1, headline) => {
  const it = { id: id++, brand, sentiment: 'negative', category: 'network', importance: 3, source: 'Youm7', published_at: isoH(hoursAgo), seen_at: isoH(hoursAgo) };
  items.push(it); outletsById.set(it.id, outlets);
  rich.push({ ...it, headline: headline || `neg ${it.id}`, summary: 's', url: 'u', resolved_url: null });
  return it;
};

// Baseline: Vodafone ~1 negative/day at EXACTLY d*24h ago (rolling bucket d,
// calendar day = d days ago), 1 outlet each → both baselines ≈ 1/bucket.
for (let d = 1; d <= 21; d++) addNeg('Vodafone', d * 24, 1);

// TODAY (Cairo), partial: two 1-outlet negatives 1h & 2h ago → weighted 2, under
// the floor of 4, so the calendar-day "today" bucket does NOT surge.
addNeg('Vodafone', 1, 1, 'Vodafone Cash outage — early reports');
addNeg('Vodafone', 2, 1, 'Vodafone Cash outage — spreading');
// YESTERDAY (Cairo) but within the last 24h: ten 1-outlet negatives 4.5h..22h
// ago. Calendar drops these into "yesterday" (a baseline day); the rolling 24h
// counts them in the CURRENT bucket → rolling current = 2 + 10 = 12.
for (const h of [4.5, 6, 7.5, 9, 10.5, 12, 14, 16, 19, 22]) addNeg('Vodafone', h, 1, `Vodafone Cash outage +${h}h`);

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  if (u.includes('/rest/v1/pr_items') && u.includes('select=id,brand')) {   // itemsForStats
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
    return json(offset === 0 ? items : []);
  }
  if (u.includes('/rest/v1/pr_items') && u.includes('select=*')) return json(rich);   // recentItems(days:1)
  if (u.includes('/rest/v1/pr_instances')) {
    const ids = decodeURIComponent((u.match(/item_id=in\.\(([^)]*)\)/) || [])[1] || '').split(',').map(Number);
    const rows = [];
    for (const iid of ids) for (let k = 0; k < (outletsById.get(iid) || 1); k++) rows.push({ item_id: iid, outlet: `o${k}`, url: `u${iid}_${k}`, published_at: isoH(1) });
    return json(rows);
  }
  throw new Error('unexpected fetch ' + u);
};

// Capture the per-run shadow log line.
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

const { detectSurges } = await import(new URL('..', import.meta.url).pathname + '/lib/surge.js');

// ── default (calendar-day): the partial "today" (2) is below floor → NO surge ──
logs.length = 0;
delete process.env.SURGE_ROLLING;
const def = await detectSurges();
assert.strictEqual(def.length, 0, `calendar-day default should miss the straddling spike, got ${def.map((s) => `${s.brand}:${s.today}`)}`);
const defLog = logs.find((l) => l.startsWith('surge detect'));
assert.ok(defLog, 'a shadow log line was emitted');
assert.ok(/calendar-day:\[none\]/.test(defLog), 'calendar-day returned none');
assert.ok(/rolling-24h:\[Vodafone /.test(defLog), 'rolling-24h shadow STILL shows the Vodafone spike for calibration');
assert.ok(!/rolling ACTIVE/.test(defLog), 'default run does not mark rolling active');

// ── SURGE_ROLLING=1: the trailing 24h captures the whole spike → Vodafone surge ──
logs.length = 0;
process.env.SURGE_ROLLING = '1';
const roll = await detectSurges();
assert.strictEqual(roll.length, 1, `rolling-24h should catch it, got ${roll.length}`);
assert.strictEqual(roll[0].brand, 'Vodafone');
assert.strictEqual(roll[0].mode, 'rolling-24h', 'returned surge is from the rolling window');
assert.strictEqual(roll[0].today, 12, `rolling current bucket = 2 (today) + 10 (<24h yesterday), got ${roll[0].today}`);
assert.ok(roll[0].multiple >= 8, `big multiple, got ${roll[0].multiple}`);
assert.ok(roll[0].topStories.length === 3, 'top stories attached from the current 24h bucket');
assert.ok(logs.find((l) => /rolling ACTIVE/.test(l)), 'active run marks rolling ACTIVE in the log');
delete process.env.SURGE_ROLLING;

Date.now = realNow;
console.log = realLog;
console.log('SURGE ROLLING OK — calendar-day misses the midnight-straddling spike (partial today=2 < floor); rolling-24h catches it (current=12); default returns calendar, SURGE_ROLLING=1 returns rolling; both logged every run');
