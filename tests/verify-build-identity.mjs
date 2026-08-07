// "Which build is production actually running?" had no answer inside the app.
//
// On 3 Aug a commit reached `main`, `git ls-remote` showed the new SHA, the
// branch preview built — and no production build was ever created. The live
// site sat on the previous commit and a shipped UI change was invisible. The
// only way to find out was to read the Vercel dashboard and believe it.
//
// lib/build.js makes the running commit a fact the app reports. The property
// that matters most is NEGATIVE: it must never invent one. A guessed SHA on the
// page whose whole job is telling you what is deployed is worse than a blank.
import assert from 'node:assert';

const VERCEL_KEYS = ['VERCEL', 'VERCEL_ENV', 'VERCEL_REGION', 'VERCEL_URL', 'VERCEL_DEPLOYMENT_ID',
  'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF', 'GIT_COMMIT_SHA', 'GITHUB_SHA', 'GITHUB_REF_NAME'];
const clearEnv = () => { for (const k of VERCEL_KEYS) delete process.env[k]; };

const { buildInfo, buildCheck } = await import('../lib/build.js');

// ── 1. off Vercel: unknown, and honest about it ───────────────────────────
{
  clearEnv();
  const info = buildInfo();
  assert.strictEqual(info.known, false, 'no SHA available ⇒ known:false');
  assert.strictEqual(info.sha, null, 'and the SHA is null, not a placeholder');
  assert.strictEqual(info.shortSha, null, 'and so is the short form');
  assert.strictEqual(info.environment, null, 'and the environment');
  // Nothing anywhere may look like a commit hash.
  assert.ok(!/[0-9a-f]{7,40}/.test(JSON.stringify({ ...info, instanceStartedAt: '' })),
    `nothing hash-shaped is invented (${JSON.stringify(info)})`);

  const c = buildCheck(info);
  assert.strictEqual(c.state, 'unknown', 'the check is UNKNOWN — not warn');
  // This is the normal state in every developer sandbox. A check that is
  // permanently amber locally is a check people stop reading, which costs the
  // eleven checks beside it their audience too.
  assert.ok(/not a Vercel deployment|system environment/i.test(c.detail), 'and says why');
  assert.ok(/Automatically expose/i.test(c.hint), 'and how to fix it if it IS a deployment');
}

// ── 2. a production deployment ────────────────────────────────────────────
{
  clearEnv();
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_REGION = 'fra1';
  process.env.VERCEL_GIT_COMMIT_SHA = '9e3fcc7a1b2c3d4e5f60718293a4b5c6d7e8f900';
  process.env.VERCEL_GIT_COMMIT_REF = 'main';
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_abc123';

  const info = buildInfo();
  assert.strictEqual(info.known, true);
  assert.strictEqual(info.shortSha, '9e3fcc7', 'the short SHA is the first 7, which is what git prints');
  assert.strictEqual(info.sha, process.env.VERCEL_GIT_COMMIT_SHA, 'the full SHA is available for an exact comparison');
  assert.strictEqual(info.ref, 'main');
  assert.strictEqual(info.environment, 'production');
  assert.strictEqual(info.region, 'fra1');

  const c = buildCheck(info);
  assert.strictEqual(c.state, 'ok', 'a production deployment is ok');
  assert.match(c.detail, /9e3fcc7/, 'the detail names the commit');
  assert.match(c.detail, /main/, 'and the branch');
  assert.match(c.detail, /production/, 'and the environment');
  // The hint has to say what to compare against, or the number is trivia.
  assert.match(c.hint, /origin\/main/, 'and says what to compare it with');
  assert.match(c.hint, /empty commit/, 'and what to do when they differ');
}

// ── 3. a PREVIEW deployment is the one case worth flagging ────────────────
// Reading Health on a preview URL while believing it is production makes every
// other number on the page describe the wrong deployment.
{
  clearEnv();
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678';
  process.env.VERCEL_GIT_COMMIT_REF = 'claude/some-branch';
  const c = buildCheck(buildInfo());
  assert.strictEqual(c.state, 'warn', 'a preview deployment warns');
  assert.match(c.hint, /not production/i, 'and says so plainly');
  assert.match(c.hint, /preview/, 'naming which environment it actually is');
}

// ── 4. deploy TIME is absent rather than approximated ─────────────────────
// Vercel exposes no deploy timestamp at runtime. The two values within reach
// are both wrong — this process started when a lambda cold-started (possibly
// days after the deploy), and "now" is not a deploy time at all. So the field
// does not exist, and the one that does carries an honest name.
{
  clearEnv();
  process.env.VERCEL_GIT_COMMIT_SHA = 'f00ba12';
  const info = buildInfo();
  assert.ok(!('deployedAt' in info), 'no deployedAt field is invented');
  assert.ok(!('buildTime' in info), 'nor a buildTime');
  assert.ok(info.instanceStartedAt, 'instanceStartedAt exists under its own name');
  assert.ok(!Number.isNaN(Date.parse(info.instanceStartedAt)), 'and is a real timestamp');
  // Module scope: the lambda's boot, not this call's.
  assert.strictEqual(buildInfo().instanceStartedAt, info.instanceStartedAt,
    'and is stable across calls — it is when the instance booted, not when you asked');
}

// ── 5. it reaches /api/alerts, as a check AND as a field ──────────────────
{
  clearEnv();
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_GIT_COMMIT_SHA = 'deadbee1234567890';
  // Distinctive values, not words like "cron" that legitimately appear in a
  // check's prose — a substring search only means something if the needle
  // cannot occur by accident.
  process.env.CRON_SECRET = 'CRONSECRET-zzq81';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'SERVICEKEY-zzq82';
  process.env.RADAR_TOKEN = 'RADARTOKEN-zzq83';
  process.env.ANTHROPIC_API_KEY = 'ANTHROPICKEY-zzq84';
  process.env.RESEND_API_KEY = 'RESENDKEY-zzq85';
  // Every probe fails; the build check must still be present and correct,
  // because it reads environment variables and touches nothing.
  globalThis.fetch = async () => { throw new Error('no network in test'); };

  const { default: alerts } = await import('../api/alerts.js');
  let out = null, code = 0;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end: () => res };
  await alerts({ method: 'GET', query: {}, headers: { authorization: 'Bearer CRONSECRET-zzq81' } }, res);

  assert.strictEqual(code, 200, 'health still answers with every probe failing');
  assert.ok(out.build, 'the payload carries a build object');
  assert.strictEqual(out.build.shortSha, 'deadbee', 'with the running commit, for an exact comparison without parsing prose');
  assert.strictEqual(out.build.environment, 'production');
  const check = out.checks.find((c) => c.id === 'build');
  assert.ok(check, 'and a build check appears among the checks');
  assert.strictEqual(check.state, 'ok');
  assert.strictEqual(out.checks[0].id, 'build',
    'FIRST in the list — every number below it describes whatever build is running');
  // No secret may ride along on a payload an admin reads and routinely pastes
  // into a chat window when asking for help.
  const blob = JSON.stringify(out);
  for (const secret of ['CRONSECRET-zzq81', 'SERVICEKEY-zzq82', 'RADARTOKEN-zzq83', 'ANTHROPICKEY-zzq84', 'RESENDKEY-zzq85']) {
    assert.ok(!blob.includes(secret), `no credential VALUE leaks into the health payload (${secret})`);
  }
  // A build object that dumped process.env wholesale would pass the value check
  // for these five and still leak the sixth.
  assert.deepStrictEqual(
    Object.keys(out.build).sort(),
    ['deploymentId', 'environment', 'instanceStartedAt', 'known', 'ref', 'region', 'sha', 'shortSha', 'url'],
    'the build object is an explicit field list, not a dump of the environment');
}

console.log('BUILD-IDENTITY OK — the running commit is reported and never invented; unknown is unknown (not amber) off Vercel; a preview deployment warns that it is not production; deploy time is absent rather than approximated; and it reaches /api/alerts first, as both a check and a field');
