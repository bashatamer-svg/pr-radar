// The release gate, asserted from inside the suite it gates.
//
// Two halves, and the second is the one that matters. A CI workflow that runs
// `npm test` looks like a gate; it is only a gate if a skipped browser test
// fails the run. Roughly half of this suite drives headless Chromium — every
// mobile-layout regression, the auth UI, the CSP proof — and those tests skip
// gracefully when no browser is present. That is right on a laptop and
// catastrophic in CI: the run goes green having exercised none of them.
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

// ── 1. the runner treats a skip as a failure under CI ─────────────────────
// Run the real runner in a subprocess against a real browser test, with
// CHROMIUM_PATH pointed at nothing. Behaviour, not source inspection.
{
  const browserTest = readdirSync(root + 'tests')
    .find((f) => f.endsWith('.mjs') && readFileSync(`${root}tests/${f}`, 'utf8').includes('playwright-core'));
  assert.ok(browserTest, 'the suite has at least one browser test to reason about');
  const filter = browserTest.replace(/\.mjs$/, '');

  const noBrowser = { ...process.env, CHROMIUM_PATH: '/nonexistent/chromium' };

  const strict = spawnSync('node', [root + 'tests/run.mjs', filter],
    { encoding: 'utf8', env: { ...noBrowser, CI: 'true' } });
  assert.strictEqual(strict.status, 1, 'CI=true: a skipped browser test FAILS the run');
  assert.match(strict.stdout, /did NOT run/, 'and the output names what did not execute');
  assert.match(strict.stdout, new RegExp(browserTest.replace('.', '\\.')), 'by filename');
  assert.match(strict.stdout, /CHROMIUM_PATH/, 'and says how to fix it');

  // Locally, the same situation must still be a pass — a developer without
  // Chromium has to be able to run the unit suite, which is why skipping
  // exists at all.
  const local = spawnSync('node', [root + 'tests/run.mjs', filter],
    { encoding: 'utf8', env: { ...noBrowser, CI: '' } });
  assert.strictEqual(local.status, 0, 'without CI: skipping is still a local convenience, not a failure');
  assert.match(local.stdout, /SKIP/, 'and it is reported honestly as a skip');
}

// ── 2. the workflow exists and gates on the right things ──────────────────
{
  const p = root + '.github/workflows/ci.yml';
  assert.ok(existsSync(p), '.github/workflows/ci.yml exists');
  const yml = readFileSync(p, 'utf8');

  assert.match(yml, /on:\s*\n\s*pull_request:/, 'runs on pull_request — the gate');
  assert.match(yml, /branches:\s*\[main/, 'and on pushes to main');
  assert.match(yml, /claude\/\*\*/, 'and on the development branches');

  // npm ci, never npm install: installing the tracked lockfile exactly is the
  // entire point of having tracked it.
  // Comments are stripped first: the file EXPLAINS why it is not npm install,
  // so matching the raw text would flag its own rationale.
  const runnable = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(runnable, /npm ci/, 'installs with npm ci');
  assert.ok(!/npm install/.test(runnable), 'and never npm install, which would resolve dependencies afresh');

  // CI=true is what arms the skip guard above.
  assert.match(yml, /CI:\s*'true'/, "sets CI=true so a skipped browser test fails the run");

  assert.match(yml, /node --check/, 'syntax-checks the JavaScript before spawning 80 test processes');
  assert.match(yml, /vercel\.json/, 'validates vercel.json — a trailing comma there is a deploy-time failure with no local symptom');
  assert.match(yml, /playwright.*install.*chromium/s, 'installs Chromium rather than hoping for one');
  assert.match(yml, /CHROMIUM_PATH:/, 'and hands the runner its path');
  assert.match(yml, /npm test/, 'runs the suite');

  // The Chromium install must not pin a CLI version by hand — it has to match
  // the installed playwright-core or it installs one browser revision while
  // executablePath() points at another.
  assert.ok(!/playwright@\d+\.\d+\.\d+/.test(yml),
    'the playwright CLI version is derived from the lockfile, not hard-coded (they must agree on the browser revision)');

  assert.match(yml, /permissions:\s*\n\s*contents:\s*read/,
    'the workflow token is read-only — this workflow writes nothing');
  assert.match(yml, /timeout-minutes:/, 'jobs have a timeout, so a hung browser cannot burn an hour');
  assert.match(yml, /npm audit/, 'a dependency audit runs');
  assert.match(yml, /--omit=dev/, 'scoped to runtime dependencies — a dev-only advisory is not a release blocker');
}

// ── 3. the settings only an owner can apply are written down ──────────────
// CI running is not CI mattering. Nothing in a repository forces a check to
// pass; that is branch protection, and it cannot be committed.
{
  const p = root + 'docs/REPOSITORY_SETTINGS.md';
  assert.ok(existsSync(p), 'docs/REPOSITORY_SETTINGS.md exists');
  const md = readFileSync(p, 'utf8');
  for (const [needle, why] of [
    [/NOT VERIFIED/i, 'it does not CLAIM protection is enabled — that would be worse than saying nothing'],
    [/Require a pull request before merging/i, 'requires a PR'],
    [/`test`/, 'names the required check by its job name'],
    [/up to date before merging/i, 'requires the branch to be current, so the MERGED tree is what was tested'],
    [/force push/i, 'blocks force pushes to the deploy source'],
    [/deletion/i, 'blocks deletion'],
    [/bypass/i, 'makes the administrator-bypass decision explicit rather than leaving it defaulted'],
    [/[Ss]ecret scanning/, 'secret scanning — this repo handles a service-role key and a cron secret'],
  ]) assert.match(md, needle, `REPOSITORY_SETTINGS.md ${why}`);
}

console.log('CI-GATE OK — a skipped browser test fails under CI and still passes locally; the workflow installs Chromium, uses npm ci, derives the Playwright version from the lockfile, and holds a read-only token; the owner-only branch protections are written down and flagged unverified');
