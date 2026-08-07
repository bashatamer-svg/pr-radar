-- Migration: a ledger of scheduled runs — did the job actually RUN?
--
-- WHY: every "did it run?" answer on Admin → Health is currently an INFERENCE
-- from an outcome. "Last story stored 20h ago" is read as "ingest is broken",
-- but it is equally consistent with a quiet news night, with every story being
-- a duplicate of one already stored (the 15-minute poll writes nothing then),
-- or with the classifier parking everything. The reverse hides worse: a cron
-- that has not fired at all for three days looks identical to three quiet days,
-- and the daily-brief check already needs two separate probes plus a schedule
-- calculation to avoid crying wolf about it.
--
-- Inference was the only option because nothing recorded execution. This
-- records it: the job started, and the job finished (or threw, and with what).
--
-- WHAT: one row per run. Deliberately compact — this is an operations log, not
-- analytics, and the counts it keeps are the ones a human asks for first:
--   * started_at / completed_at   — completed_at NULL and old = the run DIED
--                                   mid-flight, which no outcome-based check
--                                   can see at all
--   * status                      — running | ok | error
--   * duration_ms                 — a run that used to take 20s and now takes
--                                   55s is about to start hitting the 60s
--                                   function timeout
--   * stored/relevant/alert counts — what it actually delivered
--   * error_summary               — first line only, truncated; never a payload
--   * git_sha                     — WHICH BUILD ran it, so a behaviour change
--                                   can be tied to a deploy
--
-- RETENTION: rows are small and the volume is bounded and known — the 15-minute
-- poll is 96/day, everything else is single digits, so roughly 3k rows a month.
-- The Health checks only ever read the last few days. Prune with
-- `delete from pr_runs where started_at < now() - interval '90 days';`
-- whenever it matters; nothing depends on old rows.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another application's
-- `radar_*` tables. Every object here is `pr_`-prefixed. Nothing in this file
-- reads, alters or drops a `radar_*` object.
--
-- SAFETY: additive, idempotent, and NOT required. lib/runs.js swallows every
-- error including "relation does not exist", so an un-migrated database records
-- nothing and runs exactly as before. THE LEDGER MUST NEVER BE ABLE TO FAIL THE
-- JOB IT IS WATCHING — a monitoring table that can take down the ingest it
-- monitors is a worse bug than the blindness it was added to fix.
-- Rollback: `drop table pr_runs;` — it holds no application data.
--
-- Apply with the Supabase SQL editor or psql.

create table if not exists pr_runs (
  id             bigint generated always as identity primary key,
  job            text        not null,           -- radar | radar-urgent | health | report | geo
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,                    -- NULL while running, or if the run died
  status         text        not null default 'running'
                             check (status in ('running', 'ok', 'error')),
  duration_ms    int,
  stored_count   int,
  relevant_count int,
  alert_count    int,
  error_summary  text,
  git_sha        text
);

-- The queries this table exists for: "when did job X last run?" and "what has
-- run recently?". Both are newest-first over a short window.
create index if not exists pr_runs_job_started_idx on pr_runs (job, started_at desc);
create index if not exists pr_runs_started_idx     on pr_runs (started_at desc);

comment on table pr_runs is
  'One row per scheduled/manual job run. Written fail-soft by lib/runs.js; read by Admin -> Health. Never required — an absent table means runs are unrecorded, not that jobs fail.';

-- RLS on, no policies: the service-role key (used by api/*.js) bypasses RLS;
-- the anon/public PostgREST role gets zero rows. Matches every other pr_ table.
alter table pr_runs enable row level security;
