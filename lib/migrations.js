// Which migrations this code expects, and which the database says it has.
//
// Every migration in migrations/ is applied by hand and nothing recorded that
// it had been, so "is this database up to date?" could only be answered by
// looking for each object one at a time. That is how CLAUDE.md spent a week
// asserting pr_users.reset_requested_at was "NOT yet applied" when it had been:
// a wrong belief about schema state sends a reader hunting a bug in code that is
// behaving correctly.
//
// The list below is the code's side of the contract. `pr_schema_migrations` is
// the database's side. Admin → Health shows them together.
//
// THE APPLICATION NEVER WRITES TO THE LEDGER, and never applies a migration.
// Migrations are a human action taken with explicit approval; an app that could
// silently change its own schema is one that changes production while nobody is
// watching. This module only READS.

import { appliedMigrations } from './db.js';

/** Every migration in migrations/, in application order.
 *
 *  `required: false` for all of them, and that is a design property rather than
 *  an oversight — each one adds a capability the code degrades WITHOUT. The
 *  alert log, the spend gauge, the WhatsApp subscriber column and the
 *  forgot-password queue all fail soft to "feature absent" rather than to an
 *  error. So an un-migrated database is a smaller PR Radar, never a broken one,
 *  and the Health check can say "missing" without crying wolf.
 *
 *  `provides` is what a reader loses by not having it — the only thing that
 *  makes "migration X is missing" actionable rather than trivia. */
export const MIGRATIONS = Object.freeze([
  { id: '2026-08-02-pr-alerts', required: false,
    provides: 'Admin → Health keeps a 14-day alert history (without it, checks still run; nothing is remembered)' },
  { id: '2026-08-02-pr-usage', required: false,
    provides: 'API spend + prompt-cache health checks (without them, a spend cap is invisible until stories start being parked)' },
  { id: '2026-08-03-pr-subscribers-whatsapp', required: false,
    provides: 'the WhatsApp crisis list lives in Admin → Subscribers instead of an env var needing a redeploy' },
  { id: '2026-08-06-pr-users-reset-requested-at', required: false,
    provides: 'the forgot-password queue in Admin → Requests (without it, a request answers the user normally and records nothing)' },
  { id: '2026-08-07-pr-schema-migrations', required: false,
    provides: 'this ledger — which migrations have been applied' },
  { id: '2026-08-07-pr-runs', required: false,
    provides: 'the scheduled-run ledger: Health reports whether a job RAN, instead of inferring it from whether stories appeared' },
  { id: '2026-08-07-pr-feed-failure-streak', required: false,
    provides: 'an ATOMIC fail_streak increment (without it the error is still recorded and last_ok_at still drives the dead-feed check — only the consecutive-failure COUNT stops advancing)' },
]);

/** Compare code expectation against the database.
 *  → { available, applied[], missing[], unknown[] }
 *
 *  `available:false` means the ledger table itself is absent — which is the
 *  state of production until someone applies it. Reported as "unavailable",
 *  never as "everything is missing": those are opposite facts, and guessing the
 *  pessimistic one would fire a warning about six migrations that may all be
 *  applied. Fail-soft throughout; this is a diagnostic and must never be the
 *  reason a page errors. */
export async function migrationStatus() {
  let rows = null;
  try { rows = await appliedMigrations(); } catch { rows = null; }
  if (!Array.isArray(rows)) {
    return { available: false, applied: [], missing: [], unknown: MIGRATIONS.map((m) => m.id) };
  }
  const have = new Set(rows.map((r) => String(r.id)));
  const applied = MIGRATIONS.filter((m) => have.has(m.id)).map((m) => m.id);
  const missing = MIGRATIONS.filter((m) => !have.has(m.id));
  // Rows the LEDGER has that this code does not know about: the database is
  // ahead of the checkout — an older deployment, or a migration added on
  // another branch. Worth naming, because it means the running code and the
  // schema were not shipped together.
  const extra = [...have].filter((id) => !MIGRATIONS.some((m) => m.id === id));
  return { available: true, applied, missing, extra };
}

/** The migration state as a Health check. Never crit: no migration here is
    required, so the worst honest verdict is "you are missing a feature". */
export function migrationCheck(status) {
  if (!status.available) {
    return {
      id: 'migrations', label: 'Schema migrations', state: 'unknown',
      detail: 'no migration ledger in this database — apply migrations/2026-08-07-pr-schema-migrations.sql to start tracking',
      hint: 'The ledger backfills itself: it records the earlier migrations it can SEE evidence of, so applying it states what is true here rather than assuming a clean slate.',
    };
  }
  const missing = status.missing || [];
  const extraNote = status.extra?.length
    ? ` · ${status.extra.length} recorded here but unknown to this build (${status.extra.join(', ')})`
    : '';
  if (!missing.length) {
    return {
      id: 'migrations', label: 'Schema migrations', state: extraNote ? 'warn' : 'ok',
      detail: `all ${MIGRATIONS.length} applied${extraNote}`,
      hint: extraNote ? 'The database is ahead of this build — the schema and the running code were not shipped together.' : '',
    };
  }
  return {
    id: 'migrations', label: 'Schema migrations', state: 'warn',
    detail: `${status.applied.length} of ${MIGRATIONS.length} applied · missing: ${missing.map((m) => m.id).join(', ')}${extraNote}`,
    // Name what is LOST, or "a migration is missing" is trivia the reader
    // cannot act on without opening six files.
    hint: missing.map((m) => `${m.id} → ${m.provides}`).join('\n'),
  };
}
