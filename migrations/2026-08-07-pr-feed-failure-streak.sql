-- Migration: an ATOMIC increment for pr_feed_health.fail_streak.
--
-- WHY: recordFeedHealth() wrote `fail_streak: ok ? 0 : 1` — a literal 1 on every
-- failure, so the column never counted anything. A feed dead for three weeks
-- read exactly the same as one that hiccuped once, which made the field useless
-- for its stated purpose (naming the persistently-dead feeds in the bulletin
-- footer) while looking like it worked.
--
-- WHY NOT JUST READ-THEN-WRITE: because the runs overlap. The 15-minute urgent
-- poll and the 05:00 daily run both fetch the ten brand feeds, and each feed is
-- fetched inside a Promise.allSettled — so two writers can read the same value
-- and both write value+1, losing an increment. PostgREST cannot express
-- `set fail_streak = fail_streak + 1`: it only sends literal values. A function
-- can, in one statement.
--
-- WHAT: one function. INSERT ... ON CONFLICT DO UPDATE is a single atomic
-- statement — the row is locked for the duration, so concurrent callers
-- serialise and no increment is lost. It also handles the first-ever failure of
-- a feed that has no row yet, which a bare UPDATE would silently skip.
--
-- Note it deliberately does NOT touch last_ok_at: "when did this feed last
-- work" must survive a failure, and it is what brokenFeeds() actually reads.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another application's
-- radar_* tables. This function is `pr_`-prefixed and touches only
-- pr_feed_health. It creates a NEW object and redefines nothing — the other
-- app's db_size_bytes() is called by this repo but never defined by it, and the
-- same rule applies here in reverse.
--
-- SAFETY: additive, idempotent, and NOT required. lib/db.js calls this and falls
-- back when it is absent (PostgREST answers 404 for an unknown RPC) — the
-- fallback still records the error and still leaves last_ok_at alone, so
-- brokenFeeds() and the Health feed check work identically either way. What is
-- lost without it is only the streak COUNT, which is exactly what was broken
-- before this migration existed.
-- Rollback: `drop function pr_bump_feed_failure(text, text);`
--
-- Apply with the Supabase SQL editor or psql.

create or replace function pr_bump_feed_failure(p_feed_id text, p_error text)
returns int
language sql
as $$
  insert into pr_feed_health (feed_id, last_error, fail_streak)
  values (p_feed_id, left(p_error, 300), 1)
  on conflict (feed_id) do update
    set fail_streak = pr_feed_health.fail_streak + 1,
        last_error  = excluded.last_error
  returning fail_streak;
$$;

comment on function pr_bump_feed_failure(text, text) is
  'Atomically increment pr_feed_health.fail_streak for one feed and record its error. Single INSERT..ON CONFLICT statement, so concurrent radar runs cannot lose an increment. Never touches last_ok_at.';
