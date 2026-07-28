// Task 5 — itemsForStats / recentItems warn (once) when a row cap truncates a
// window, and only then. Mocks fetch so rest() returns controlled row counts.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';   // captured at module load
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

let MODE = {};
const rowsOf = (n, base = 0) => Array.from({ length: n }, (_, i) => ({ id: base + i, brand: 'Vodafone', importance: 3 }));

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
  if (u.includes('/rest/v1/pr_items')) {
    if (u.includes('order=importance')) return ok(rowsOf(MODE.recent));               // recentItems: single page
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);                    // itemsForStats: paginated
    if (MODE.statsFull) return ok(rowsOf(1000, offset));                               // every page full → 10000
    return ok(offset === 0 ? rowsOf(MODE.statsShort, 0) : []);
  }
  return ok([]);
};

// Capture console.warn
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

const { itemsForStats, recentItems } = await import(new URL('..', import.meta.url).pathname + '/lib/db.js');
const reset = () => { warns.length = 0; };

// ── recentItems: full page (== limit) warns; a short page doesn't ──
reset(); MODE = { recent: 200 };
let r = await recentItems({ days: 7, limit: 200 });
assert.strictEqual(r.length, 200, 'recentItems returns the rows');
assert.strictEqual(warns.filter((w) => /board window capped at 200/.test(w)).length, 1, 'cap warning fires once at the limit');

reset(); MODE = { recent: 50 };
r = await recentItems({ days: 7, limit: 200 });
assert.strictEqual(r.length, 50, 'recentItems returns the short result');
assert.strictEqual(warns.length, 0, 'no warning below the cap');

// a custom smaller limit still warns at exactly that limit
reset(); MODE = { recent: 25 };
await recentItems({ days: 1, limit: 25 });
assert.ok(warns.some((w) => /capped at 25 rows for the 1d window/.test(w)), 'warning names the actual limit + window');

// ── itemsForStats: all pages full → 10000 ceiling warns; short window doesn't ──
reset(); MODE = { statsFull: true };
let s = await itemsForStats({ days: 30, withText: true });
assert.strictEqual(s.length, 10000, 'itemsForStats returns all 10000 fetched');
assert.strictEqual(warns.filter((w) => /10000-row ceiling for the 30d window/.test(w)).length, 1, '10000-row ceiling warning fires once');

reset(); MODE = { statsFull: false, statsShort: 500 };
s = await itemsForStats({ days: 30 });
assert.strictEqual(s.length, 500, 'itemsForStats returns the short window');
assert.strictEqual(warns.length, 0, 'no warning when the window fits under the ceiling');

console.warn = origWarn;
console.log('DB CAPS OK — recentItems warns once at the row cap, itemsForStats warns once at the 10000 ceiling; neither warns below; return values unchanged');
