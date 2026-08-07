// Admin → Health (/api/alerts): the eighteen live pipeline checks.
//
// Three properties are load-bearing, and all three are ways a health page can
// be worse than none:
//
//  1. ADMIN ONLY. It reports operational internals — recipient lists, spend,
//     what the classifier is dropping. A viewer must not see it.
//  2. ONE DEAD TABLE MUST NOT BLANK THE PAGE. pr_alerts and pr_usage are not
//     migrated in production, and a page that 500s the moment an optional table
//     is missing is a page nobody trusts. Each probe degrades to its own
//     'unknown' and the other checks still answer.
//  3. A QUIET DAY IS NOT A FAULT. PR Radar sends no brief when nothing clears
//     the Impact-2 bar (api/radar.js builds the digest from relevant items at
//     importance >= 2), and it has genuinely quiet weeks. A bulletin check that
//     went red every quiet stretch would be ignored by the time it mattered —
//     so a stale marker is only critical when stories were actually waiting.
//
// Plus the push rule: ?notify=1 emails only on warn/crit, and suppresses a
// repeat of the SAME failing set within 22h so a chronic problem mails once
// rather than every morning until it is filtered.
import assert from 'node:assert';
import { MIGRATIONS } from '../lib/migrations.js';
const MIGRATION_IDS = MIGRATIONS.map((m) => m.id);

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.CRON_SECRET = 'cronsecret';
process.env.RADAR_TOKEN = 'viewertoken';
process.env.RESEND_API_KEY = 're_x';
process.env.RADAR_FROM = 'radar@example.com';
process.env.OPS_ALERT_TO = 'ops@example.com';
delete process.env.RADAR_TO;               // production's actual state
delete process.env.REPORT_EMAIL_ENABLED;
// The build check reads Vercel's system environment variables. The healthy
// world below IS production, so give it production's: without them the check
// correctly reports 'unknown' (see the explicit case at the end), and an
// unknown outranks ok in the page badge.
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.VERCEL_GIT_COMMIT_SHA = '9e3fcc7a1b2c3d4e5f60718293a4b5c6d7e8f900';
process.env.VERCEL_GIT_COMMIT_REF = 'main';

const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();

// The one bearer the mocked GoTrue accepts as a signed-in human.
const SESSION = 'session-token-for-boss';

// One knob per behaviour under test; the mock below reads them.
let world;
const freshWorld = () => ({
  bulletinAt: hoursAgo(2),        // brief went out this morning
  digestEligible: 4,              // …and there were stories for it
  // What the digest WOULD have carried at the last scheduled 05:00Z run.
  // Defaults to the same number; the false-alarm case below is exactly the
  // one where these two disagree.
  digestEligibleAtDue: null,      // null → same as digestEligible
  lastSeen: hoursAgo(1),
  stored24h: 70, relevant24h: 5,
  parked: 0,
  subscribers: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
  brokenFeeds: [],
  alertsTable: true, alertLog: [],
  // Eight cached classify calls today: cheap, and reading the cache far more
  // than writing it — which is what "the screen is cheap" actually depends on.
  usageTable: true,
  usage: Array.from({ length: 8 }, () => ({
    stage: 'classify', model: 'test-model', created_at: hoursAgo(3),
    input_tokens: 500, output_tokens: 800, cache_create_tokens: 2000, cache_read_tokens: 20000,
  })),
  dbSizeFn: true, dbBytes: 22 * 1048576,
  // Both hand-applied ledgers present and current. `migrationsTable:false` and
  // `runsTable:false` below cover the un-migrated state, which is production's
  // today and must read as "unavailable", never as an alarm.
  migrationsTable: true, migrationsApplied: null,   // null → every known migration
  runsTable: true,
  runs: [
    { job: 'radar-urgent', started_at: hoursAgo(0.2), completed_at: hoursAgo(0.1), status: 'ok', duration_ms: 11000 },
    { job: 'radar', started_at: hoursAgo(4), completed_at: hoursAgo(3.9), status: 'ok', duration_ms: 38000 },
    { job: 'health', started_at: hoursAgo(3), completed_at: hoursAgo(3), status: 'ok', duration_ms: 2000 },
  ],
  resendList: { data: [] },
  // counts: recent stored, recent relevant, baseline stored, baseline relevant
  quality: [700, 42, 2100, 126],
  // relevant-in-window, missing-author, stale-missing
  authors: [70, 30, 20],
});

let sent = [];
let recorded = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const json = (body, headers = {}) => ({
    ok: true, status: 200,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  const countOf = (n) => ({
    ok: true, status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `0-0/${n}` : null) },
    text: async () => '[]', json: async () => [],
  });
  const dead = (status = 404) => ({
    ok: false, status,
    headers: { get: () => null },
    text: async () => 'relation does not exist',
    json: async () => ({}),
  });

  // ── auth: a session token is validated against GoTrue, then resolved to a
  //    role through pr_users. Only the one token below is a real session.
  if (u.includes('/rest/v1/pr_users')) return json([{ email: 'boss@vodafone.com', role: 'admin', active: true }]);
  if (u.includes('/auth/v1')) {
    const bearer = (opts.headers?.Authorization || '').replace(/^Bearer\s+/, '');
    return bearer === SESSION ? json({ email: 'boss@vodafone.com' }) : dead(401);
  }

  // ── optional tables ──
  if (u.includes('/rest/v1/pr_schema_migrations')) {
    if (!world.migrationsTable) return dead();
    const ids = world.migrationsApplied ?? MIGRATION_IDS;
    return json(ids.map((id) => ({ id, applied_at: hoursAgo(48) })));
  }
  if (u.includes('/rest/v1/pr_runs')) {
    if (!world.runsTable) return dead();
    if (m === 'POST') return json([{ id: 1 }]);
    if (m === 'PATCH') return json([]);
    return json(world.runs);
  }
  if (u.includes('/rest/v1/pr_alerts')) {
    if (!world.alertsTable) return dead();
    if (m === 'POST') { recorded.push(JSON.parse(opts.body)); return json(null); }
    return json(world.alertLog);
  }
  if (u.includes('/rest/v1/pr_usage')) return world.usageTable ? json(world.usage) : dead();
  if (u.includes('/rest/v1/rpc/db_size_bytes')) return world.dbSizeFn ? json(world.dbBytes) : dead();

  // ── the always-present tables ──
  if (u.includes('/rest/v1/pr_state')) {
    return json(world.bulletinAt ? [{ updated_at: world.bulletinAt }] : []);
  }
  if (u.includes('/rest/v1/pr_feed_health')) return json(world.brokenFeeds);
  if (u.includes('/rest/v1/pr_subscribers')) return json(world.subscribers);

  if (u.includes('/rest/v1/pr_items')) {
    // Counting queries carry Prefer: count=exact; the ordered select does not.
    const counting = /count=exact/.test(opts.headers?.Prefer || '');
    if (!counting) return json(world.lastSeen ? [{ seen_at: world.lastSeen }] : []);
    // Distinguish the count queries by their predicates.
    if (u.includes('category=eq.unclassified')) return countOf(world.parked);
    if (u.includes('author=is.null')) {
      return countOf(u.includes('seen_at=lt.') ? world.authors[2] : world.authors[1]);
    }
    if (u.includes('importance=gte.2')) {
      // Two windows are asked for: one ending NOW (no lt), one ending at the
      // last scheduled run (carries an lt). Only the second can prove a miss.
      const atDue = u.includes('seen_at=lt.');
      if (atDue && world.digestEligibleAtDue !== null) return countOf(world.digestEligibleAtDue);
      return countOf(world.digestEligible);
    }
    // relevanceBaseline + authorBacklog + ingestSummary share this shape; the
    // baseline windows are the ones carrying BOTH a gte and an lt on seen_at.
    const windowed = u.includes('seen_at=gte.') && u.includes('seen_at=lt.');
    const rel = u.includes('is_relevant=is.true');
    if (windowed) {
      // The recent window ends at "now" (no lt older than ~1min); crude but the
      // baseline window is always the older of the two.
      const lt = new Date(u.match(/seen_at=lt\.([^&]+)/)[1]);
      const isBaseline = Date.now() - lt.getTime() > 60_000;
      if (isBaseline) return countOf(rel ? world.quality[3] : world.quality[2]);
      return countOf(rel ? world.quality[1] : world.quality[0]);
    }
    if (u.includes('or=(published_at')) return countOf(rel ? world.authors[0] : world.authors[0]);
    return countOf(rel ? world.relevant24h : world.stored24h);
  }

  if (u.includes('api.resend.com')) {
    if (m === 'POST') { sent.push(JSON.parse(opts.body)); return json({ id: 'em_1' }); }
    return json(world.resendList);
  }
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/alerts.js');

const call = async ({ bearer = 'cronsecret', query = {} } = {}) => {
  let code = 200, out = null;
  const res = {
    status: (c) => { code = c; return res; },
    json: (b) => { out = b; return res; },
    setHeader() {}, end() { return res; },
  };
  await handler({ method: 'GET', query, headers: { authorization: `Bearer ${bearer}` } }, res);
  return { code, out };
};
const byId = (out, id) => (out.checks || []).find((c) => c.id === id);

/* 1 ── admin only ───────────────────────────────────────────────────────── */
{
  world = freshWorld();
  const { code } = await call({ bearer: 'viewertoken' });
  assert.strictEqual(code, 403, `the read-only viewer token must not see ops internals (got ${code})`);

  const anon = await call({ bearer: 'nonsense' });
  assert.strictEqual(anon.code, 401, `an unknown bearer is rejected (got ${anon.code})`);

  const admin = await call();
  assert.strictEqual(admin.code, 200, 'the admin/cron bearer gets the page');
  assert.strictEqual(admin.out.checks.length, 18, `all eighteen checks report (got ${admin.out.checks.length})`);
  // The build check leads: every number under it describes whatever code is
  // running, and reading a preview deployment while believing it is production
  // makes the whole page describe the wrong thing.
  assert.strictEqual(admin.out.checks[0].id, 'build', 'the deployed build is reported first');
  assert.strictEqual(admin.out.checks[1].id, 'migrations',
    'and the schema it is running against second — every check below describes a build against a schema');
  assert.strictEqual(admin.out.build.shortSha, '9e3fcc7', 'and rides the payload as a field for exact comparison');
  // WhatsApp is deliberately OFF in production and the house-knowledge doc is
  // empty in this world, so both read 'ok'/'unknown' rather than green — the
  // page badge takes the WORST check, so this asserts what a healthy world
  // actually looks like rather than an idealised one.
  assert.ok(['ok', 'unknown'].includes(admin.out.status), `a healthy world reads ok or unknown (got ${admin.out.status}: ` +
    `${admin.out.checks.filter((c) => c.state !== 'ok').map((c) => `${c.id}=${c.state}`).join(', ')})`);
}

/* 2 ── a missing optional table degrades ONE check, never the page ──────── */
{
  world = freshWorld();
  world.alertsTable = false;    // pr_alerts not migrated (production today)
  world.usageTable = false;     // pr_usage not migrated (production today)
  world.dbSizeFn = false;
  const { code, out } = await call();
  assert.strictEqual(code, 200, 'the page still renders with three probes dead');
  assert.strictEqual(out.logAvailable, false, 'and says the history is unavailable rather than empty');
  assert.deepStrictEqual(out.log, [], 'with no rows invented');
  for (const id of ['spend', 'storage', 'cache']) {
    assert.strictEqual(byId(out, id).state, 'unknown', `${id} degrades to unknown`);
  }
  // The checks that do NOT depend on those tables must be unaffected.
  for (const id of ['bulletin', 'ingest', 'classify', 'recipients', 'feeds', 'quality', 'authors', 'weekly']) {
    assert.strictEqual(byId(out, id).state, 'ok', `${id} still answers (got ${byId(out, id).state})`);
  }
  assert.strictEqual(out.status, 'unknown', 'and the page badge is "partly unknown", not a false all-clear');
}

/* 3 ── a quiet day is not a fault; a swallowed brief is ─────────────────── */
{
  // Nothing cleared Impact 2 for eleven days: no brief was DUE.
  world = freshWorld();
  world.bulletinAt = hoursAgo(11 * 24);
  world.digestEligible = 0;
  const quiet = (await call()).out;
  assert.strictEqual(byId(quiet, 'bulletin').state, 'ok',
    'a stale marker with nothing to send is the pipeline working, not failing');
  assert.match(byId(quiet, 'bulletin').hint, /no brief to send/i, 'and it says so in as many words');

  // Same stale marker, but four stories were waiting. That is the real failure.
  world = freshWorld();
  world.bulletinAt = hoursAgo(11 * 24);
  world.digestEligible = 4;
  const swallowed = (await call()).out;
  assert.strictEqual(byId(swallowed, 'bulletin').state, 'crit',
    'stories waiting + no brief in over a day is critical');
  assert.strictEqual(swallowed.status, 'crit', 'and the worst check drives the page badge');

  // …and the case in between, which is the one that actually fired. Stories are
  // queued NOW, but every one of them landed AFTER the last scheduled run — so
  // that run had nothing to send and the brief is not late, it is not yet due.
  // Judged on "stale marker + anything queued" this went CRITICAL at 01:08
  // Cairo on 3 Aug with 5 queued and 0 that had been available at 05:00Z.
  world = freshWorld();
  world.bulletinAt = hoursAgo(11 * 24);
  world.digestEligible = 5;          // queued right now…
  world.digestEligibleAtDue = 0;     // …none of them by the last 05:00Z run
  const notYetDue = (await call()).out;
  assert.strictEqual(byId(notYetDue, 'bulletin').state, 'ok',
    'stories that arrived after the scheduled run are not evidence of a missed send');
  assert.match(byId(notYetDue, 'bulletin').detail, /5 story\(s\) queued for the next brief/,
    'the queue is still reported, just not as a fault');
  assert.match(byId(notYetDue, 'bulletin').hint, /goes out at 05:00 UTC/,
    'and the reader is told when it will go');

  // The mirror image: the run DID have stories and the marker still did not
  // advance. That is a genuinely swallowed brief, however quiet it is now.
  world = freshWorld();
  world.bulletinAt = hoursAgo(11 * 24);
  world.digestEligible = 0;          // nothing queued at this moment…
  world.digestEligibleAtDue = 3;     // …but three were waiting when it ran
  const reallyMissed = (await call()).out;
  assert.strictEqual(byId(reallyMissed, 'bulletin').state, 'crit',
    'a run that had stories and did not stamp the marker is still critical');
  assert.match(byId(reallyMissed, 'bulletin').hint, /had 3 story\(s\) to send/,
    'and the hint says how many it should have carried');
}

/* 4 ── the recipient trap: a brief with nowhere to go ───────────────────── */
{
  world = freshWorld();
  world.subscribers = [];                    // and RADAR_TO is unset above
  const out = (await call()).out;
  assert.strictEqual(byId(out, 'recipients').state, 'crit',
    'no subscribers and no RADAR_TO means every send throws and reaches nobody');

  world = freshWorld();                      // subscribers present, RADAR_TO still unset
  const ok = (await call()).out;
  assert.strictEqual(byId(ok, 'recipients').state, 'ok', 'the subscriber list alone is a working brief');
  assert.match(byId(ok, 'recipients').hint, /RADAR_TO is unset/,
    'but it still names the missing team copy rather than implying full health');
}

/* 5 ── parked stories: invisible everywhere else ────────────────────────── */
{
  world = freshWorld(); world.parked = 3;
  assert.strictEqual(byId((await call()).out, 'classify').state, 'warn', 'a few parked stories warn');
  world = freshWorld(); world.parked = 25;
  assert.strictEqual(byId((await call()).out, 'classify').state, 'crit', 'a burst is critical');
}

/* 6 ── screening quality is judged over weeks, and refuses thin data ────── */
{
  world = freshWorld();
  world.quality = [700, 8, 2100, 126];      // 1.1% now vs 6.0% before — a collapse
  assert.strictEqual(byId((await call()).out, 'quality').state, 'crit', 'a screening collapse is critical');

  world = freshWorld();
  world.quality = [40, 2, 60, 4];           // too little on both sides
  assert.strictEqual(byId((await call()).out, 'quality').state, 'unknown',
    'thin data reads unknown rather than implying health');
}

/* 7 ── bylines are judged as a share, because half of Egyptian copy is unsigned */
{
  world = freshWorld();
  world.authors = [70, 30, 20];             // 43% — the observed norm
  assert.strictEqual(byId((await call()).out, 'authors').state, 'ok',
    'unsigned wire copy is normal, not a fault');

  world = freshWorld();
  world.authors = [70, 60, 55];             // 86% — fetches being blocked wholesale
  assert.strictEqual(byId((await call()).out, 'authors').state, 'warn',
    'but a rate far above that is a blocked fetcher');
}

/* 8 ── the push emails on a problem, and refuses to nag ─────────────────── */
{
  // All clear → no mail at all. An alert channel that also fires on good news
  // is one people filter.
  world = freshWorld(); sent = []; recorded = [];
  const clear = (await call({ query: { notify: '1' } })).out;
  assert.strictEqual(clear.notified.sent, false, 'a healthy run sends nothing');
  assert.strictEqual(sent.length, 0, 'literally no mail');

  // A problem → one mail, and one history row written BEFORE the send.
  world = freshWorld(); world.parked = 25; sent = []; recorded = [];
  const fired = (await call({ query: { notify: '1' } })).out;
  assert.strictEqual(fired.notified.sent, true, 'a failing check emails');
  assert.strictEqual(sent.length, 1, `exactly one mail (got ${sent.length})`);
  assert.deepStrictEqual(sent[0].to, ['ops@example.com'], 'to the ops address, never the subscriber list');
  assert.match(sent[0].subject, /Classification/, 'the subject names the failing check');
  assert.strictEqual(recorded.length, 1, 'and it is recorded in history');
  assert.match(recorded[0].detail, /parked/, 'with the detail, so it can be read back later');

  // The SAME problem, already alerted 3h ago → suppressed. This is what stops a
  // chronic condition mailing every morning until it is ignored.
  world = freshWorld(); world.parked = 25; sent = []; recorded = [];
  world.alertLog = [{ title: 'PR Radar health: Classification', severity: 'critical',
    created_at: hoursAgo(3), kind: 'ops', detail: '' }];
  const dup = (await call({ query: { notify: '1' } })).out;
  assert.strictEqual(dup.notified.sent, false, 'an unchanged problem does not re-mail');
  assert.match(dup.notified.reason, /already alerted/, 'and says why');
  assert.strictEqual(sent.length, 0, 'no mail');

  // A DIFFERENT check failing changes the subject → alerts at once, even though
  // the old alert is still inside the 22h window.
  world = freshWorld(); world.parked = 25; world.subscribers = []; sent = []; recorded = [];
  world.alertLog = [{ title: 'PR Radar health: Classification', severity: 'critical',
    created_at: hoursAgo(3), kind: 'ops', detail: '' }];
  const escalated = (await call({ query: { notify: '1' } })).out;
  assert.strictEqual(escalated.notified.sent, true, 'a new failing check alerts immediately');
  assert.match(sent[0].subject, /Brief recipients/, 'and the subject names it');

  // TWO operators → two messages, not one addressed to both. Nobody should be
  // shown the rest of the ops list, and one bad address must not swallow the
  // alert for everyone else — Resend rejects the whole call over one entry.
  process.env.OPS_ALERT_TO = 'ops@example.com, second.ops@example.com';
  world = freshWorld(); world.parked = 25; sent = []; recorded = [];
  const fanned = (await call({ query: { notify: '1' } })).out;
  assert.strictEqual(fanned.notified.sent, true, 'still sends');
  assert.strictEqual(sent.length, 2, `one message per operator (got ${sent.length})`);
  for (const m of sent) {
    assert.strictEqual(m.to.length, 1, `each carries exactly one address (got ${JSON.stringify(m.to)})`);
  }
  assert.deepStrictEqual(sent.flatMap((m) => m.to).sort(), ['ops@example.com', 'second.ops@example.com'],
    'and between them they cover the ops list');
  assert.strictEqual(recorded.length, 1, 'the history still records the alert ONCE, not once per recipient');
  process.env.OPS_ALERT_TO = 'ops@example.com';
}

/* 9 ── off Vercel the build check is UNKNOWN, and only that check ─────────── */
// Every developer sandbox is in this state. A check that goes amber there is a
// check people stop reading — and it takes the eleven beside it with it.
{
  world = freshWorld();
  // EVERY source lib/build.js reads, not just the Vercel ones. It falls back to
  // GITHUB_SHA on purpose (so the build identity works on a GitHub runner too),
  // and clearing only VERCEL_* left this case asserting "no SHA available" in an
  // environment that had one. It passed on every laptop and failed the moment it
  // ran in CI — which is the environment that sets GITHUB_SHA, and exactly the
  // kind of gap a release gate exists to find.
  for (const k of ['VERCEL', 'VERCEL_ENV', 'VERCEL_REGION', 'VERCEL_URL', 'VERCEL_DEPLOYMENT_ID',
    'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF', 'GIT_COMMIT_SHA', 'GITHUB_SHA', 'GITHUB_REF_NAME']) {
    delete process.env[k];
  }
  const { out } = await call();
  const build = out.checks.find((c) => c.id === 'build');
  assert.strictEqual(build.state, 'unknown', 'no SHA available ⇒ unknown');
  assert.notStrictEqual(build.state, 'warn', 'and never warn — this is the normal local state');
  assert.strictEqual(out.build.known, false, 'the payload says so too');
  assert.strictEqual(out.build.sha, null, 'and invents nothing');
  // Everything else is unaffected: one check not knowing something must not
  // colour the others. WhatsApp (deliberately off) and the run/migration
  // ledgers legitimately read 'unknown' here too — what matters is that none of
  // them turned into a warn or a crit because the BUILD check could not answer.
  const others = out.checks.filter((c) => c.id !== 'build');
  assert.ok(others.every((c) => c.state === 'ok' || c.state === 'unknown'),
    `no other check degraded: ${others.filter((c) => !['ok', 'unknown'].includes(c.state)).map((c) => `${c.id}=${c.state}`).join(', ')}`);
  process.env.VERCEL = '1'; process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_GIT_COMMIT_SHA = '9e3fcc7a1b2c3d4e5f60718293a4b5c6d7e8f900';
}

/* 10 ── with NEITHER ledger applied — production's state today ───────────── */
// Both tables are hand-applied and neither is live yet. Missing must read as
// "unavailable", never as "nothing ran" or "everything is un-migrated": the
// pessimistic reading would put the page permanently amber on the very database
// it is meant to reassure you about.
{
  world = freshWorld();
  world.migrationsTable = false;
  world.runsTable = false;
  const { code, out } = await call();
  assert.strictEqual(code, 200, 'the page still answers');
  const mig = out.checks.find((c) => c.id === 'migrations');
  const runs = out.checks.find((c) => c.id === 'runs');
  assert.strictEqual(mig.state, 'unknown', 'an absent migration ledger is unknown, not warn');
  assert.strictEqual(runs.state, 'unknown', 'an absent run ledger is unknown, not crit');
  assert.ok(!out.checks.some((c) => c.id === 'runstall'),
    'and the completion check is omitted rather than added as a second unknown');
  // Everything else keeps working — that is the whole fail-soft contract. The
  // WhatsApp channel reads 'unknown' because it is deliberately OFF, which is
  // production's state and not a degradation.
  const others = out.checks.filter((c) => !['migrations', 'runs', 'build'].includes(c.id));
  const degraded = others.filter((c) => !['ok', 'unknown'].includes(c.state));
  assert.deepStrictEqual(degraded.map((c) => `${c.id}=${c.state}`), [],
    'no other check degrades when the two ledgers are absent');
}

console.log('HEALTH-CHECKS OK — 18 admin-only checks (build + schema state first, then recorded runs); a missing optional table degrades one check, not the page; '
  + 'a quiet day reads ok while a swallowed brief reads crit; the daily push mails on warn/crit only and suppresses a repeat within 22h');
