// Two ledgers, one shared property: they must be able to be ABSENT.
//
// Migrations here are applied by hand, so both tables will be missing in
// production until someone runs the SQL — and a monitoring table that breaks
// the thing it monitors is a worse bug than the blindness it was added to fix.
//
//   pr_schema_migrations — which migrations this database has. Nothing recorded
//     it before, which is how CLAUDE.md spent a week asserting that
//     pr_users.reset_requested_at was "NOT yet applied" when it had been.
//   pr_runs — whether a scheduled job actually RAN. Every "did it run?" answer
//     on Health was an inference from an outcome, and "no new stories in 20h"
//     is equally consistent with a quiet night, with every story being a
//     duplicate, and with the cron never firing at all.
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const { MIGRATIONS, migrationStatus, migrationCheck } = await import('../lib/migrations.js');
const { runChecks, startRun, JOBS, runJob } = await import('../lib/runs.js');

/* ═══ 1. the migration ledger ══════════════════════════════════════════════ */

// Every migration FILE has an entry, and every entry has a file. A list that
// drifts from the folder is the same class of bug as the schema.sql drift it
// was added to prevent.
{
  const files = readdirSync(root + 'migrations').filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, '')).sort();
  const ids = MIGRATIONS.map((m) => m.id).sort();
  assert.deepStrictEqual(ids, files,
    'MIGRATIONS in lib/migrations.js must match migrations/*.sql exactly, in both directions');
  for (const m of MIGRATIONS) {
    assert.ok(m.provides && m.provides.length > 20,
      `${m.id} must say what is LOST without it — "a migration is missing" is trivia a reader cannot act on`);
  }
  // Every one is optional BY DESIGN: each adds a capability the code degrades
  // without, so an un-migrated database is a smaller PR Radar, never a broken
  // one. If that ever stops being true the check has to be able to go crit.
  assert.ok(MIGRATIONS.every((m) => m.required === false),
    'every migration is optional — the code fails soft to "feature absent" for all of them');
}

const mockDb = (handler) => { globalThis.fetch = handler; };
const rows = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
const gone = () => ({ ok: false, status: 404, text: async () => 'relation "pr_schema_migrations" does not exist' });

// Absent table → UNAVAILABLE, never "everything is missing". Those are opposite
// facts, and guessing the pessimistic one warns about six migrations that may
// all be applied — which is exactly the wrong belief this ledger exists to end.
{
  mockDb(async () => gone());
  const st = await migrationStatus();
  assert.strictEqual(st.available, false, 'a missing ledger reports unavailable');
  assert.deepStrictEqual(st.missing, [], 'and does NOT claim the migrations are missing');
  const c = migrationCheck(st);
  assert.strictEqual(c.state, 'unknown', 'the check is unknown, not warn');
  assert.match(c.detail, /no migration ledger/i, 'and says why');
  assert.match(c.detail, /2026-08-07-pr-schema-migrations\.sql/, 'naming the file that fixes it');
}
// All recorded → ok.
{
  mockDb(async () => rows(MIGRATIONS.map((m) => ({ id: m.id, applied_at: '2026-08-07T00:00:00Z' }))));
  const st = await migrationStatus();
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.missing.length, 0);
  assert.strictEqual(migrationCheck(st).state, 'ok');
}
// Some missing → warn, naming them AND what each one costs.
{
  mockDb(async () => rows([{ id: '2026-08-02-pr-alerts' }, { id: '2026-08-02-pr-usage' }]));
  const st = await migrationStatus();
  const c = migrationCheck(st);
  assert.strictEqual(c.state, 'warn', 'missing migrations warn');
  assert.ok(!/crit/.test(c.state), 'never crit — none of them is required');
  assert.match(c.detail, new RegExp(`2 of ${MIGRATIONS.length} applied`), 'the count is explicit');
  assert.match(c.detail, /2026-08-06-pr-users-reset-requested-at/, 'and the missing ids are named');
  assert.match(c.hint, /forgot-password queue/, 'and the hint says what is actually lost');
}
// The database is AHEAD of the code — an older deployment, or a migration from
// another branch. Worth saying: schema and code were not shipped together.
{
  mockDb(async () => rows([...MIGRATIONS.map((m) => ({ id: m.id })), { id: '2027-01-01-from-the-future' }]));
  const c = migrationCheck(await migrationStatus());
  assert.strictEqual(c.state, 'warn', 'an unknown recorded migration warns');
  assert.match(c.detail, /2027-01-01-from-the-future/, 'and names it');
  assert.match(c.hint, /not shipped together/i, 'explaining what that means');
}

/* ═══ 2. the run ledger ════════════════════════════════════════════════════ */

const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();

// Absent → unavailable, not "nothing ran".
{
  const [c] = runChecks(null);
  assert.strictEqual(c.state, 'unknown', 'a missing run ledger is unknown');
  assert.match(c.detail, /still inferred/, 'and says the old inference is what is still in use');
  assert.match(c.hint, /2026-08-07-pr-runs\.sql/, 'naming the file');
}
// Present but empty — a fresh migration, before the next cron fires.
{
  const [c] = runChecks([]);
  assert.strictEqual(c.state, 'unknown', 'an empty ledger is unknown, not an alarm');
  assert.match(c.hint, /until the next cron fires/i, 'and says when to start worrying');
}
// Healthy.
{
  const out = runChecks([
    { job: 'radar-urgent', started_at: ago(0.2), completed_at: ago(0.1), status: 'ok', duration_ms: 12000 },
    { job: 'radar', started_at: ago(6), completed_at: ago(5.9), status: 'ok', duration_ms: 41000 },
    { job: 'health', started_at: ago(5), completed_at: ago(5), status: 'ok', duration_ms: 3000 },
  ]);
  assert.strictEqual(out.find((c) => c.id === 'runs').state, 'ok');
  assert.match(out.find((c) => c.id === 'runs').detail, /radar-urgent/, 'the summary names each job and its age');
  assert.strictEqual(out.find((c) => c.id === 'runstall').state, 'ok');
}
// A cron that STOPPED. This is the case no outcome-based check can distinguish
// from a quiet week — the whole reason the ledger exists.
{
  const out = runChecks([
    { job: 'radar-urgent', started_at: ago(30), completed_at: ago(30), status: 'ok', duration_ms: 9000 },
    { job: 'radar', started_at: ago(30), completed_at: ago(30), status: 'ok', duration_ms: 9000 },
  ]);
  const c = out.find((x) => x.id === 'runs');
  assert.strictEqual(c.state, 'crit', 'a job well past its schedule is critical');
  assert.match(c.detail, /overdue/, 'and says overdue');
  assert.match(c.detail, /radar-urgent/, 'naming the job');
  assert.match(c.hint, /did not fire, rather than firing and finding nothing/,
    'and distinguishes it from a quiet night, which is the entire point');
}
// …AND IT MUST STAY CRITICAL. The recent-runs window is nine days; a job dead
// for longer than that has no row inside it at all, so deriving "when did X
// last run?" from that query alone made the outage CURE ITSELF — the job looked
// as though it had never been recorded, the overdue check skipped it, and a
// cron stopped for a fortnight went quiet on the page instead of red. The
// per-job latest read has no horizon, and it is what the clock reads.
{
  const out = runChecks(
    // Only the still-alive job is inside the window.
    [{ job: 'radar-urgent', started_at: ago(0.2), completed_at: ago(0.1), status: 'ok', duration_ms: 9000 }],
    Date.now(),
    [{ job: 'radar-urgent', started_at: ago(0.2), completed_at: ago(0.1), status: 'ok', duration_ms: 9000 },
     { job: 'radar', started_at: ago(14 * 24), completed_at: ago(14 * 24), status: 'ok', duration_ms: 9000 }],
  );
  const c = out.find((x) => x.id === 'runs');
  assert.strictEqual(c.state, 'crit', 'a job dead longer than the query window is STILL critical');
  assert.match(c.detail, /overdue: radar \(/, 'and is named, with its true age');
  assert.match(c.detail, /14d/, 'which is the age the short window could not have known');
}

// A MANUAL run must not answer "did the schedule fire?". Every one of these
// endpoints is operator-gated, which admits signed-in admins — so an
// interactive /api/geo click wrote the same `geo` key and reset an eight-day
// overdue clock, hiding a dead cron for another week.
{
  const out = runChecks(
    [{ job: 'geo:manual', started_at: ago(1), completed_at: ago(1), status: 'ok', duration_ms: 4000 },
     { job: 'radar', started_at: ago(2), completed_at: ago(2), status: 'ok', duration_ms: 9000 }],
    Date.now(),
    [{ job: 'geo:manual', started_at: ago(1), completed_at: ago(1), status: 'ok', duration_ms: 4000 },
     { job: 'geo', started_at: ago(20 * 24), completed_at: ago(20 * 24), status: 'ok', duration_ms: 4000 },
     { job: 'radar', started_at: ago(2), completed_at: ago(2), status: 'ok', duration_ms: 9000 }],
  );
  const c = out.find((x) => x.id === 'runs');
  assert.strictEqual(c.state, 'crit', 'the manual run an hour ago does not excuse the cron that has not fired in 20 days');
  assert.match(c.detail, /overdue: geo \(/, 'geo is still reported overdue');
  assert.ok(!/geo:manual/.test(c.detail), 'and the manual key is not listed as a scheduled job');
}
// …but a manual run is still WATCHED. It can stall or throw like any other, and
// the completion check reads every row, whatever the key.
{
  const out = runChecks([
    { job: 'geo:manual', started_at: ago(3), completed_at: null, status: 'running' },
    { job: 'radar', started_at: ago(1), completed_at: ago(1), status: 'ok', duration_ms: 9000 },
  ]);
  const c = out.find((x) => x.id === 'runstall');
  assert.strictEqual(c.state, 'warn', 'a manual run killed mid-flight is still reported');
  assert.match(c.detail, /geo:manual/, 'by name');
}
// The key itself: only the cron's own service principal is "scheduled".
{
  assert.strictEqual(runJob(JOBS.geo, { kind: 'service', actor: 'service:cron', role: 'admin' }), 'geo',
    'the cron writes the scheduled key');
  assert.strictEqual(runJob(JOBS.geo, { kind: 'user', actor: 'a@b.com', email: 'a@b.com', role: 'admin' }), 'geo:manual',
    'a signed-in admin writes a manual key');
  assert.strictEqual(runJob(JOBS.radar, undefined), 'radar:manual',
    'and an unknown principal is manual — never silently counted as the schedule');
}

// A run KILLED mid-flight. It writes nothing and throws nothing — a lambda hit
// by the 60s cap leaves only an open row, so this is the only place it shows.
{
  const out = runChecks([
    { job: 'radar', started_at: ago(3), completed_at: null, status: 'running' },
    { job: 'radar-urgent', started_at: ago(0.1), completed_at: ago(0.05), status: 'ok', duration_ms: 8000 },
  ]);
  const c = out.find((x) => x.id === 'runstall');
  assert.strictEqual(c.state, 'warn', 'a run that never finished warns');
  assert.match(c.detail, /never finished/, 'and says so');
  assert.match(c.hint, /function timeout/, 'and names the likely cause');
}
// A run still open but only MINUTES old is in flight, not dead.
{
  const out = runChecks([{ job: 'radar', started_at: ago(0.05), completed_at: null, status: 'running' }]);
  assert.strictEqual(out.find((x) => x.id === 'runstall').state, 'ok',
    'a run that started two minutes ago is running, not stalled');
}
// A recorded failure carries its reason.
{
  const out = runChecks([
    { job: 'radar', started_at: ago(1), completed_at: ago(1), status: 'error', error_summary: 'supabase 503' },
  ]);
  const c = out.find((x) => x.id === 'runstall');
  assert.strictEqual(c.state, 'warn');
  assert.match(c.detail, /supabase 503/, 'the recorded error is shown');
}
// Creeping duration is the warning before the cliff: a run killed at the cap
// records nothing at all, so the useful moment to notice is before that.
{
  const out = runChecks([{ job: 'radar', started_at: ago(1), completed_at: ago(1), status: 'ok', duration_ms: 52000 }]);
  assert.match(out.find((x) => x.id === 'runstall').hint, /60s function cap/,
    'a run near the timeout is flagged while it still completes');
}

/* ═══ 3. THE PRIME DIRECTIVE: the ledger never fails the job ═══════════════ */
{
  // Every DB call throws — a missing table, a dead network, a 500.
  mockDb(async () => { throw new Error('database on fire'); });
  const run = await startRun(JOBS.radar);
  assert.strictEqual(run.id, null, 'an unrecordable run yields a null id rather than throwing');
  // And every method on the handle must still be safe to call.
  await run.ok({ stored: 3, relevant: 1, alerts: 0 });
  await run.fail(new Error('x'));
  assert.ok(true, 'closing an unrecorded run is a no-op, not a crash');

  // The same, one level down: a table that exists for the insert and vanishes
  // for the update.
  let calls = 0;
  mockDb(async () => { calls++; return calls === 1 ? rows([{ id: 7 }]) : gone(); });
  const r2 = await startRun(JOBS.radarUrgent);
  assert.strictEqual(r2.id, 7, 'the run opened');
  await r2.ok({ stored: 1 });
  assert.ok(true, 'and a failed close is swallowed');
}
// An error_summary is the first line only, truncated. A stack trace or a
// response body in an ops table is a place for a secret to end up by accident.
{
  let patched = null;
  mockDb(async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH') { patched = JSON.parse(opts.body); return rows([]); }
    return rows([{ id: 1 }]);
  });
  const run = await startRun(JOBS.radar);
  await run.fail(new Error('boom: token=SECRET\n  at foo\n  at bar\n' + 'x'.repeat(500)));
  assert.ok(!patched.error_summary.includes('at foo'), 'only the first line is recorded');
  assert.ok(patched.error_summary.length <= 300, `and it is truncated (got ${patched.error_summary.length})`);
}

/* ═══ 4. both are wired into /api/alerts, and neither can break it ═════════ */
{
  process.env.CRON_SECRET = 'cronsecret';
  // EVERY probe fails, including both ledgers. The page must still answer.
  mockDb(async () => { throw new Error('everything is down'); });
  const { default: alerts } = await import('../api/alerts.js');
  let out = null, code = 0;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end: () => res };
  await alerts({ method: 'GET', query: {}, headers: { authorization: 'Bearer cronsecret' } }, res);

  assert.strictEqual(code, 200, 'health answers even with both ledgers unreachable');
  const ids = out.checks.map((c) => c.id);
  for (const id of ['build', 'migrations', 'runs']) {
    assert.ok(ids.includes(id), `the ${id} check is present`);
  }
  // `runstall` deliberately does NOT appear when the ledger is unreachable:
  // "did a run die?" is unanswerable without rows, and a second unknown beside
  // the first would be two lines saying one thing.
  assert.ok(!ids.includes('runstall'),
    'the completion check is omitted when there are no rows to judge, rather than added as a second unknown');
  // Order matters: what is running and what schema it is running against come
  // before every number that depends on both.
  assert.deepStrictEqual(ids.slice(0, 2), ['build', 'migrations'],
    'build and migration state lead — every check below them describes a particular build against a particular schema');
  assert.strictEqual(out.checks.find((c) => c.id === 'migrations').state, 'unknown',
    'an unreachable migration ledger is unknown, never an alarm');
  assert.strictEqual(out.checks.find((c) => c.id === 'runs').state, 'unknown',
    'and so is an unreachable run ledger');
  assert.ok(out.migrations, 'the payload carries the migration status as a field');
}

/* ═══ 5. the SQL is safe to apply ══════════════════════════════════════════ */
for (const f of ['2026-08-07-pr-schema-migrations.sql', '2026-08-07-pr-runs.sql']) {
  const sql = readFileSync(`${root}migrations/${f}`, 'utf8');
  const code = sql.replace(/^\s*--.*$/gm, '');
  assert.match(sql, /-- WHY:/, `${f} carries the WHY/WHAT/SAFETY header every migration here has`);
  assert.match(sql, /SAFETY:/, `${f} says what happens if it is NOT applied`);
  assert.match(sql, /Rollback:/, `${f} says how to undo it`);
  assert.match(code, /create table if not exists/, `${f} is idempotent`);
  assert.match(code, /enable row level security/, `${f} enables RLS — no policies means only the service key reads`);
  assert.ok(!/create policy/i.test(code), `${f} creates no policy`);
  // Shared project: another application's radar_* tables live in this database.
  assert.ok(!/\bradar_\w+/.test(code), `${f} must never touch a radar_* object`);
  for (const bad of [/\bdrop\s+table\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i, /\balter\s+table\s+radar/i]) {
    assert.ok(!bad.test(code), `${f} contains nothing destructive (${bad})`);
  }
}
// The backfill must be EVIDENCE-BASED. A ledger born asserting that four
// migrations are applied, without checking, would be a confident lie — and a
// confident lie about schema state is what this table exists to prevent.
{
  const sql = readFileSync(root + 'migrations/2026-08-07-pr-schema-migrations.sql', 'utf8');
  assert.match(sql, /information_schema\.tables/, 'the backfill checks for the tables it claims');
  assert.match(sql, /information_schema\.columns/, 'and for the columns');
  assert.match(sql, /on conflict \(id\) do nothing/, 'and is re-runnable');
  for (const id of MIGRATIONS.map((m) => m.id).filter((i) => i < '2026-08-07')) {
    assert.ok(sql.includes(`'${id}'`), `the backfill covers ${id}`);
  }
}
// The application must never APPLY a migration or write to the ledger. A
// migration is a human action taken with approval; an app that can change its
// own schema changes production while nobody is watching.
{
  for (const dir of ['api', 'lib']) {
    for (const f of readdirSync(root + dir).filter((n) => n.endsWith('.js'))) {
      const src = readFileSync(`${root}${dir}/${f}`, 'utf8');
      assert.ok(!/pr_schema_migrations['"`\s]*,?\s*\{\s*method:\s*['"](POST|PATCH|DELETE|PUT)/i.test(src)
        && !/method:\s*['"](POST|PATCH|PUT|DELETE)['"][\s\S]{0,200}pr_schema_migrations/i.test(src),
        `${dir}/${f} must not write to pr_schema_migrations — the app reads it, humans write it`);
      assert.ok(!/\b(create|alter|drop)\s+table\b/i.test(src.replace(/^\s*(\/\/|\*).*$/gm, '')),
        `${dir}/${f} must not contain DDL — migrations are applied by hand, with approval`);
    }
  }
}

console.log('LEDGERS OK — migration state and run state are both READ-ONLY to the app and both degrade to "unavailable" rather than to an alarm; a stopped cron is distinguished from a quiet night, a killed run from a slow one; the ledger cannot fail the job it watches; the SQL is idempotent, RLS-on, touches no radar_* object, and backfills only on evidence');
