// Which build is actually serving this request.
//
// PR Radar has already been bitten by not knowing. On 3 Aug a commit reached
// `main`, `git ls-remote` showed the new SHA, the branch preview built — and no
// production build was ever created. The live site sat on the previous commit
// and a shipped UI change was simply invisible. Nothing in the app could have
// answered "what is production running?", so the only way to find out was to
// read the Vercel dashboard and believe it.
//
// This makes the running commit a fact the app itself reports, so the check is
// `git rev-parse origin/main` against a number on the Health page rather than a
// dashboard reading.
//
// NOTHING IS FABRICATED. Vercel injects these at runtime when "Automatically
// expose System Environment Variables" is on (the default). Where a value is
// absent — a local checkout, the sandbox, or that setting turned off — the
// answer is `null` and the UI says "unknown". A guessed SHA on a page whose
// entire job is telling you what is deployed would be worse than a blank.

const env = (k) => {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : null;
};

/** Build/deployment identity. Every field may be null.
 *
 *  → { sha, shortSha, ref, environment, region, deploymentId, url,
 *      instanceStartedAt, known }
 *
 *  `deployedAt` is deliberately ABSENT rather than approximated. Vercel exposes
 *  no deploy timestamp at runtime, and the two values within reach are both
 *  wrong: this process started when a lambda cold-started (which can be days
 *  after the deploy), and "now" is not a deploy time at all. `instanceStartedAt`
 *  is reported under its own honest name instead — it answers a different and
 *  occasionally useful question (how warm is this lambda), and it is never
 *  presented as when the code shipped. */
export function buildInfo() {
  const sha = env('VERCEL_GIT_COMMIT_SHA') || env('GIT_COMMIT_SHA') || env('GITHUB_SHA');
  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    ref: env('VERCEL_GIT_COMMIT_REF') || env('GITHUB_REF_NAME'),
    // 'production' | 'preview' | 'development' on Vercel; null anywhere else.
    environment: env('VERCEL_ENV') || (env('VERCEL') ? 'unknown' : null),
    region: env('VERCEL_REGION'),
    deploymentId: env('VERCEL_DEPLOYMENT_ID'),
    url: env('VERCEL_URL'),
    instanceStartedAt: INSTANCE_STARTED_AT,
    known: !!sha,
  };
}

// Module scope, so it is the moment this lambda instance booted rather than the
// moment the request arrived. Warm lambdas persist module state — usually a
// hazard in this codebase, used deliberately here.
const INSTANCE_STARTED_AT = new Date().toISOString();

/** The build identity as a Health check.
 *
 *  Never `warn` or `crit` on its own: not knowing the SHA is normal off Vercel,
 *  and a check that is permanently amber in every developer's sandbox is a
 *  check people stop reading. It reports, and it says what to compare against.
 *
 *  The ONE thing it does flag is reading a NON-production deployment while
 *  believing you are looking at production — an easy mistake with preview URLs,
 *  and one that makes every other number on the page describe the wrong thing. */
export function buildCheck(info = buildInfo()) {
  if (!info.known) {
    return {
      id: 'build', label: 'Deployed build', state: 'unknown',
      detail: 'no commit SHA available — this is not a Vercel deployment, or system environment variables are not exposed',
      hint: 'Expected locally. On Vercel: Settings → Environment Variables → "Automatically expose System Environment Variables".',
    };
  }
  const where = [info.environment, info.region].filter(Boolean).join(' · ');
  const detail = `${info.shortSha}${info.ref ? ` on ${info.ref}` : ''}${where ? ` — ${where}` : ''}`;
  if (info.environment && info.environment !== 'production') {
    return {
      id: 'build', label: 'Deployed build', state: 'warn', detail,
      hint: `This is the ${info.environment} deployment, not production. Every number on this page describes ${info.environment}.`,
    };
  }
  return {
    id: 'build', label: 'Deployed build', state: 'ok', detail,
    hint: 'Compare with `git rev-parse origin/main`. A mismatch means the push did not produce a production build — re-trigger with an empty commit; Vercel needs a new SHA.',
  };
}
