// pr_feed_health.fail_streak never counted anything.
//
// recordFeedHealth wrote `fail_streak: ok ? 0 : 1` — a LITERAL 1 on every
// failure. So a feed dead for three weeks read identically to one that hiccuped
// once, and the column that exists to name the persistently-dead feeds was
// decorative while looking like it worked.
//
// It cannot be fixed by reading the value and writing value+1. The runs OVERLAP:
// the 15-minute urgent poll and the 05:00 daily run both fetch the ten brand
// feeds, and each feed is fetched inside a Promise.allSettled — so two writers
// read the same number and both write the same increment, losing one. PostgREST
// cannot express `set x = x + 1` either. The increment therefore goes through a
// Postgres function doing INSERT..ON CONFLICT DO UPDATE, which is one atomic
// statement.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const { recordFeedHealth, brokenFeeds } = await import('../lib/db.js');

// A fake PostgREST that models the two things that matter: upsert-merge
// semantics (only the columns PRESENT in the payload are written) and the RPC.
let table, calls, rpcAvailable;
const reset = ({ rpc = true, rows = {} } = {}) => {
  table = { ...rows }; calls = []; rpcAvailable = rpc;
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, method: opts.method, body });
  const ok = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v ?? []) });

  if (u.includes('/rpc/pr_bump_feed_failure')) {
    if (!rpcAvailable) {
      return { ok: false, status: 404, text: async () => 'Could not find the function public.pr_bump_feed_failure' };
    }
    const id = body.p_feed_id;
    // Exactly what the SQL does: insert, or increment on conflict. Atomic in
    // Postgres; modelled as a single step here.
    const row = table[id] || { feed_id: id, last_ok_at: null, last_error: null, fail_streak: 0 };
    table[id] = { ...row, fail_streak: (table[id] ? row.fail_streak : 0) + 1, last_error: String(body.p_error).slice(0, 300) };
    return ok([{ fail_streak: table[id].fail_streak }]);
  }
  if (u.includes('pr_feed_health') && (opts.method || 'GET') === 'POST') {
    const id = body.feed_id;
    const row = table[id] || { feed_id: id, last_ok_at: null, last_error: null, fail_streak: 0 };
    // merge-duplicates updates ONLY the keys present in the payload. This is
    // the semantic the failure fallback depends on: fail_streak is omitted, so
    // an existing count survives untouched.
    for (const k of Object.keys(body)) row[k] = body[k];
    table[id] = row;
    return ok([]);
  }
  if (u.includes('pr_feed_health')) {
    return ok(Object.values(table).filter((r) => !r.last_ok_at || new Date(r.last_ok_at) < new Date(Date.now() - 3 * 864e5)));
  }
  throw new Error('unexpected ' + u);
};

/* ── 1. consecutive failures INCREMENT ──────────────────────────────────── */
{
  reset();
  for (let i = 0; i < 5; i++) await recordFeedHealth('youm7', false, `http 503 (attempt ${i})`);
  assert.strictEqual(table.youm7.fail_streak, 5,
    `five consecutive failures is a streak of 5, not 1 (got ${table.youm7.fail_streak})`);
  assert.match(table.youm7.last_error, /attempt 4/, 'and the newest error is what is kept');
  // last_ok_at must SURVIVE a failure — "when did this feed last work" is what
  // brokenFeeds() reads, and clearing it would make every feed look never-alive.
  assert.strictEqual(table.youm7.last_ok_at, null, 'a feed that has never worked still has no last_ok_at');
}

/* ── 2. success RESETS ──────────────────────────────────────────────────── */
{
  reset();
  await recordFeedHealth('almal', false, 'http 500');
  await recordFeedHealth('almal', false, 'http 500');
  assert.strictEqual(table.almal.fail_streak, 2);
  await recordFeedHealth('almal', true);
  assert.strictEqual(table.almal.fail_streak, 0, 'a success resets the streak to 0');
  assert.strictEqual(table.almal.last_error, null, 'and clears the error');
  assert.ok(table.almal.last_ok_at, 'and stamps last_ok_at');
  // …and it starts counting again from there.
  await recordFeedHealth('almal', false, 'http 502');
  assert.strictEqual(table.almal.fail_streak, 1, 'the next failure starts a NEW streak at 1');
}

/* ── 3. the increment is atomic, so overlapping runs cannot lose one ────── */
{
  // The real concurrency: the urgent poll and the daily run hit the same feed
  // at the same moment. A read-then-write implementation loses increments here;
  // one INSERT..ON CONFLICT statement cannot.
  reset();
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordFeedHealth('shorouk', false, `err ${i}`)));
  assert.strictEqual(table.shorouk.fail_streak, 20,
    `twenty concurrent failures produce a streak of 20 (got ${table.shorouk.fail_streak}) — a lost update would show here`);

  // And the write goes through the RPC, not a literal. This is what makes the
  // property above true in Postgres rather than only in this mock.
  const rpcCalls = calls.filter((c) => c.u.includes('/rpc/pr_bump_feed_failure'));
  assert.strictEqual(rpcCalls.length, 20, 'every failure went through the atomic function');
  for (const c of calls) {
    if (c.body && 'fail_streak' in c.body) {
      assert.strictEqual(c.body.fail_streak, 0,
        'no request ever sends a literal fail_streak except the 0 that a SUCCESS writes');
    }
  }
}

/* ── 4. without the migration, the fallback is still HONEST ─────────────── */
// The function is applied by hand, so production runs without it until someone
// does. The fallback must not resurrect the old bug.
{
  reset({ rpc: false, rows: { masrawy: { feed_id: 'masrawy', last_ok_at: '2026-08-01T00:00:00Z', last_error: null, fail_streak: 7 } } });
  await recordFeedHealth('masrawy', false, 'http 403');
  assert.strictEqual(table.masrawy.last_error, 'http 403', 'the error is still recorded');
  assert.strictEqual(table.masrawy.last_ok_at, '2026-08-01T00:00:00Z',
    'last_ok_at is untouched — it is what the dead-feed check actually reads');
  // The key difference from the old behaviour: a count it cannot compute is
  // LEFT ALONE. Writing 1 would actively assert something false; leaving 7 is
  // stale but honest, and the payload omits the column entirely so the upsert
  // cannot overwrite it.
  assert.strictEqual(table.masrawy.fail_streak, 7,
    `an uncomputable streak is left alone, never reset to 1 (got ${table.masrawy.fail_streak})`);
  const post = calls.find((c) => c.u.includes('pr_feed_health') && c.method === 'POST');
  assert.ok(!('fail_streak' in post.body), 'the fallback payload omits fail_streak entirely');
  assert.ok(!('last_ok_at' in post.body), 'and omits last_ok_at, so a success timestamp survives');

  // Success still works fully without the migration — that is what makes it
  // optional rather than required.
  await recordFeedHealth('masrawy', true);
  assert.strictEqual(table.masrawy.fail_streak, 0, 'a success resets even with no RPC available');
  assert.strictEqual(table.masrawy.last_error, null);
}

/* ── 5. brokenFeeds still answers, and now says HOW broken ──────────────── */
{
  reset({ rows: {
    dead:  { feed_id: 'dead',  last_ok_at: null, last_error: 'http 404', fail_streak: 41 },
    stale: { feed_id: 'stale', last_ok_at: new Date(Date.now() - 5 * 864e5).toISOString(), last_error: 'timeout', fail_streak: 6 },
    fine:  { feed_id: 'fine',  last_ok_at: new Date().toISOString(), last_error: null, fail_streak: 0 },
  } });
  const broken = await brokenFeeds();
  const ids = broken.map((b) => b.feed_id).sort();
  assert.deepStrictEqual(ids, ['dead', 'stale'], 'a healthy feed is not reported');
  // "failed 41 times in a row" and "has never worked since it was added" are
  // different problems with different fixes; the feed id alone distinguishes
  // neither, which is why the streak is now selected alongside it.
  const dead = broken.find((b) => b.feed_id === 'dead');
  assert.strictEqual(dead.fail_streak, 41, 'the streak rides along');
  assert.strictEqual(dead.last_ok_at, null, 'and so does "never succeeded"');
}

/* ── 6. the SQL is one atomic statement, and touches nothing else ───────── */
{
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('..', import.meta.url).pathname + 'migrations/2026-08-07-pr-feed-failure-streak.sql', 'utf8');
  const code = sql.replace(/^\s*--.*$/gm, '');
  assert.match(code, /on conflict \(feed_id\) do update/i,
    'INSERT..ON CONFLICT — one statement, so concurrent callers serialise instead of racing');
  assert.match(code, /fail_streak\s*=\s*pr_feed_health\.fail_streak \+ 1/,
    'and the increment reads the CURRENT row inside that statement, not a value fetched earlier');
  // The function BODY only: the `comment on function` text below it says the
  // words "last_ok_at" precisely because this is the property being described.
  const body = code.match(/as \$\$([\s\S]*?)\$\$/)[1];
  assert.ok(!/last_ok_at/.test(body),
    'the function never touches last_ok_at — a failure must not erase when the feed last worked');
  assert.ok(!/\bradar_\w+/.test(code), 'and never a radar_* object (shared project)');
  assert.ok(!/drop\s+table|truncate|delete\s+from/i.test(code), 'and nothing destructive');
  assert.match(sql, /Rollback:/, 'with a rollback line');
}

console.log('FEED-STREAK OK — consecutive failures increment (5 in a row is 5, not 1), a success resets and restarts, 20 concurrent writers lose nothing, and without the migration the count is left alone rather than falsely reset to 1');
