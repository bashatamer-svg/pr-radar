// Did the job actually RUN?
//
// Every "did it run?" answer on Admin → Health is currently an inference from an
// outcome. "Last story stored 20h ago" reads as broken ingest, but it is equally
// consistent with a quiet news night, or with every story being a duplicate of
// one already stored (the 15-minute poll writes nothing then). The reverse hides
// worse: a cron that has not fired for three days looks exactly like three quiet
// days, and the daily-brief check already needs two probes plus a schedule
// calculation to avoid crying wolf about precisely this ambiguity.
//
// This records execution instead of inferring it: the job started, and the job
// finished — or died, which is the case no outcome-based check can see at all.
//
// THE PRIME DIRECTIVE OF THIS MODULE: it must never be able to fail the job it
// is watching. A monitoring table that can take down the ingest it monitors is
// a worse bug than the blindness it was added to fix. So every function here
// swallows everything — a missing table, a network blip, a malformed row — and
// the caller cannot tell the difference between "recorded" and "not recorded".
// That is deliberate: there is nothing useful a pipeline can do about a failed
// audit write, and the one harmful thing it could do is stop.

import { insertRun, finishRun } from './db.js';
import { buildInfo } from './build.js';

/** Job names. A closed set, because "how long since job X ran?" needs the
    reader and the writer to agree on the spelling, and a typo would present as
    a job that has never run rather than as a mistake. */
export const JOBS = Object.freeze({
  radar: 'radar',                 // the daily full run
  radarUrgent: 'radar-urgent',    // the 15-minute poll
  health: 'health',               // /api/alerts?notify=1
  report: 'report',               // the Monday weekly report
  geo: 'geo',                     // the Monday answer-engine check
});

const first = (s) => String(s ?? '').split('\n')[0].slice(0, 300);

/** Open a run. Returns a handle whose `.finish()` closes it.
 *
 *  The handle works whether or not the row was written, so callers never branch
 *  on it. `id` is null when the ledger is unavailable and every method is a
 *  no-op — which is the un-migrated state, and it must be indistinguishable
 *  from the migrated one as far as the pipeline is concerned. */
export async function startRun(job, meta = {}) {
  const startedAt = Date.now();
  let id = null;
  try {
    id = await insertRun({
      job,
      status: 'running',
      // Which BUILD ran it, so a behaviour change can be tied to a deploy
      // rather than to "something changed around Tuesday".
      git_sha: buildInfo().sha || null,
      ...meta,
    });
  } catch { id = null; }

  const close = async (status, fields) => {
    if (!id) return;
    try {
      await finishRun(id, {
        status,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        ...fields,
      });
    } catch { /* the ledger must never fail the job */ }
  };

  return {
    id,
    /** Close as a success, with what the run delivered. */
    ok: (counts = {}) => close('ok', {
      stored_count: num(counts.stored),
      relevant_count: num(counts.relevant),
      alert_count: num(counts.alerts),
    }),
    /** Close as a failure. Only the first line of the message, truncated —
        an error_summary is for recognising a repeat at a glance, and a stack
        trace or a response body in an ops table is a place for a secret to end
        up by accident. */
    fail: (err) => close('error', { error_summary: first(err?.message || err) }),
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);

/** Wrap a job so the ledger cannot be forgotten on one path.
 *
 *  The failure mode this prevents is specific: a handler with several early
 *  returns (?dry=1, ?debug=1, an error path) closes the run on the branch
 *  someone remembered and leaves it 'running' forever on the others — which the
 *  stalled-run check would then report as a dead job every single day. */
export async function withRun(job, meta, fn) {
  const run = await startRun(job, meta);
  try {
    const result = await fn(run);
    await run.ok(result && typeof result === 'object' ? result.counts : undefined);
    return result;
  } catch (e) {
    await run.fail(e);
    throw e;                     // the ledger observes; it never swallows the job's own error
  }
}

/* ── Health checks ──────────────────────────────────────────────────────────
   Two checks, answering the two questions inference cannot:

     "did the job RUN?"     — separate from "did anything appear?", which a
                              quiet news night and a dead cron answer alike
     "did a run DIE?"       — a row still `running` long after it should have
                              finished. No outcome-based check can see this at
                              all: a lambda killed at the 60-second timeout
                              writes nothing and throws nothing.
   ────────────────────────────────────────────────────────────────────────── */

// How long after its schedule a job may go unseen before it is worth saying so.
// Set off the SCHEDULE plus real slack, not off the cadence alone: the
// 15-minute poll missing one fire is noise, missing two hours of them is not.
const OVERDUE_H = {
  'radar-urgent': 2,      // every 15 min
  radar: 26,              // daily 05:00
  health: 26,             // daily 05:45
  report: 8 * 24,         // Mondays
  geo: 8 * 24,            // Mondays
};
// A run is judged DEAD, not slow, once it has been open far longer than the
// function could possibly live. Vercel caps /api/radar at 60s, so anything
// still `running` after 30 minutes was killed rather than delayed.
const STALL_MIN = 30;

/** Build the run-ledger checks from recentRuns() output.
 *  `rows === null` means the table is absent — reported as UNAVAILABLE, never
 *  as "nothing ran". Those are opposite facts and guessing the alarming one
 *  would put the page permanently red on an un-migrated database. */
export function runChecks(rows, now = Date.now()) {
  if (!Array.isArray(rows)) {
    return [{
      id: 'runs', label: 'Scheduled runs', state: 'unknown',
      detail: 'no run ledger in this database — every "did it run?" answer here is still inferred from whether stories appeared',
      hint: 'Apply migrations/2026-08-07-pr-runs.sql to record execution directly.',
    }];
  }

  const out = [];
  // Only jobs that are supposed to fire on their own. A report/geo run behind a
  // dormant feature flag still fires (the cron calls it and it returns), so
  // they belong here — but only once the ledger has ever seen them, or a fresh
  // database would warn about five jobs at once for its first week.
  const seen = new Map();     // job -> newest row
  for (const r of rows) if (!seen.has(r.job)) seen.set(r.job, r);

  const late = [];
  for (const [job, hours] of Object.entries(OVERDUE_H)) {
    const last = seen.get(job);
    if (!last) continue;                       // never recorded — see the note above
    const age = (now - new Date(last.started_at).getTime()) / 36e5;
    if (age > hours) late.push(`${job} (${age < 48 ? `${age.toFixed(0)}h` : `${(age / 24).toFixed(0)}d`} ago)`);
  }

  const failed = rows.filter((r) => r.status === 'error');
  const stalled = rows.filter((r) => r.status === 'running'
    && (now - new Date(r.started_at).getTime()) / 60000 > STALL_MIN);

  if (!seen.size) {
    out.push({
      id: 'runs', label: 'Scheduled runs', state: 'unknown',
      detail: 'the ledger is present but empty — no run has been recorded yet',
      hint: 'Expected until the next cron fires. If it stays empty past that, the crons are not running at all.',
    });
    return out;
  }

  const summary = [...seen.entries()]
    .map(([job, r]) => `${job} ${fmtAgo((now - new Date(r.started_at).getTime()) / 36e5)}`)
    .join(' · ');

  if (late.length) {
    out.push({
      id: 'runs', label: 'Scheduled runs', state: 'crit',
      detail: `overdue: ${late.join(', ')} · ${summary}`,
      hint: 'The cron did not fire, rather than firing and finding nothing. Check the Vercel cron log and vercel.json.',
    });
  } else {
    out.push({ id: 'runs', label: 'Scheduled runs', state: 'ok', detail: summary });
  }

  // A run that never closed. Separate check: it means something different from
  // "overdue" (the job DID start) and has a different fix.
  if (stalled.length) {
    out.push({
      id: 'runstall', label: 'Run completion', state: 'warn',
      detail: `${stalled.length} run(s) started and never finished — newest ${stalled[0].job} at ${stalled[0].started_at}`,
      hint: 'A run killed by the function timeout writes nothing and throws nothing, so this is the only place it shows. If /api/radar is near its 60s cap, the fix is fewer feeds per run, not a longer timeout.',
    });
  } else if (failed.length) {
    out.push({
      id: 'runstall', label: 'Run completion', state: 'warn',
      detail: `${failed.length} failed run(s) — newest ${failed[0].job}: ${failed[0].error_summary || 'no detail recorded'}`,
      hint: 'The run recorded its own failure, so the job started and threw. The summary is the first line of the error.',
    });
  } else {
    const durations = rows.filter((r) => Number.isFinite(r.duration_ms)).map((r) => r.duration_ms);
    const slowest = durations.length ? Math.max(...durations) : null;
    out.push({
      id: 'runstall', label: 'Run completion', state: 'ok',
      detail: `${rows.length} run(s) recorded, all finished${slowest != null ? ` · slowest ${(slowest / 1000).toFixed(1)}s` : ''}`,
      hint: slowest != null && slowest > 45000
        ? 'The slowest run is close to the 60s function cap — a run killed there records nothing and is invisible everywhere else.'
        : '',
    });
  }
  return out;
}

const fmtAgo = (h) => {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${h.toFixed(0)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
