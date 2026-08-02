-- Migration: persisted admin alert log (backs Admin → Health, "Recent alerts").
--
-- WHY: PR Radar has never had a record of a pipeline problem. An ops failure
-- either produced an email nobody kept, or produced nothing at all — so there
-- was no way to answer "has this happened before?" or "how long has it been
-- like this?". The live checks on Admin → Health answer "right now"; this
-- answers "and what has been going wrong".
--
-- WHAT: one row per alert raised. lib/email.js sendOpsAlert() writes here
-- BEFORE sending, so the log is complete even when the email itself is
-- misconfigured or fails — which, given RADAR_TO has been unset in production
-- since 22 Jul 2026, is the likely case until someone sets OPS_ALERT_TO.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another app's
-- `radar_*` tables. Every object here is `pr_`-prefixed. Nothing in this file
-- reads, alters or drops a `radar_*` object.
--
-- SAFETY: NOT auto-applied, and NOT required. recordAlert() swallows the
-- "relation does not exist" error and /api/alerts reports logAvailable:false —
-- so all twelve live health checks work fully without this table. Apply it when
-- you want history kept. Rollback: `drop table pr_alerts;`.
--
-- Apply with the Supabase SQL editor or psql. Idempotent.

create table if not exists pr_alerts (
  id          bigserial primary key,
  kind        text        not null default 'ops',   -- ops | classify | budget | …
  severity    text        not null default 'warn',  -- info | warn | critical
  title       text        not null,
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists pr_alerts_created_idx on pr_alerts (created_at desc);

-- RLS on, no policies: the service-role key (used by api/*.js) bypasses RLS;
-- the anon/public PostgREST role gets zero rows. Matches every other pr_ table.
alter table pr_alerts enable row level security;
