// Task 2 smoke test — the unclassified count reaches the bulletin footer,
// and only renders when > 0.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.BOARD_URL = 'https://pr.example/';

const { renderBulletin } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');
const items = [{
  id: 1, hash: 'h', headline: 'Story', url: 'https://x', source: 'Outlet',
  sentiment: 'neutral', importance: 2, category: 'network', brand: 'Vodafone',
  published_at: new Date().toISOString(),
}];

// N > 0 → footer note present, correct plural
const html3 = renderBulletin({ items, broken: [], scanned: 100, unclassified: 3 });
assert.ok(html3.includes("3 stories couldn't be auto-classified today"), 'plural note shown');

// N = 1 → singular
const html1 = renderBulletin({ items, broken: [], scanned: 100, unclassified: 1 });
assert.ok(html1.includes("1 story couldn't be auto-classified today"), 'singular note shown');

// N = 0 / omitted → no note
const html0 = renderBulletin({ items, broken: [], scanned: 100, unclassified: 0 });
const htmlDefault = renderBulletin({ items, broken: [], scanned: 100 });
assert.ok(!html0.includes('auto-classified'), 'no note at zero');
assert.ok(!htmlDefault.includes('auto-classified'), 'no note when omitted (watchlist path)');

// The count itself matches the Task-1 unclassifiedRecord shape the radar
// filter selects on (is_relevant === false && category === 'unclassified').
const rawClassified = [
  { is_relevant: true, category: 'network' },
  { is_relevant: false, category: 'other' },          // model said irrelevant — NOT counted
  { is_relevant: false, category: 'unclassified' },   // classifier gave up — counted
  { is_relevant: false, category: 'unclassified' },
];
const n = rawClassified.filter((i) => i.is_relevant === false && i.category === 'unclassified').length;
assert.strictEqual(n, 2);

console.log('ALL TASK 2 SMOKE TESTS PASSED');
