-- Migration: a ledger of which migrations have been applied.
--
-- WHY: every migration in this folder is applied by hand, and NOTHING recorded
-- that it had been. The only way to answer "is this database up to date?" was to
-- go and look for each object one at a time — which is exactly why CLAUDE.md
-- spent a week asserting that pr_users.reset_requested_at was "NOT yet applied"
-- when it had been. A wrong belief about schema state is worse than no belief:
-- it sends a reader hunting a bug in code that is behaving correctly, and it
-- makes the next person's "apply the pending migration" a no-op they will not
-- notice.
--
-- WHAT: one row per applied migration, keyed by the migration file's name
-- without the .sql extension. That id is stable, sorts chronologically, and is
-- greppable — `2026-08-03-pr-subscribers-whatsapp` names the exact file.
--
-- BACKFILL, and why it checks rather than asserts: the four migrations that
-- predate this ledger have already been applied to production, so the table
-- would otherwise be born claiming they were pending. The DO block below
-- records each one ONLY IF its object actually exists in this database. Run
-- against production it records four; run against a fresh database built from
-- schema.sql it records the ones schema.sql created; run against an empty
-- database it records none. In every case the ledger states what is true HERE,
-- which is the entire value of having it.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another application's
-- `radar_*` tables. Every object here is `pr_`-prefixed, and the detection
-- queries below read only `pr_*` rows out of the catalogue. Nothing in this file
-- reads, alters or drops a `radar_*` object.
--
-- SAFETY: additive, idempotent, and NOT required by the application.
-- lib/migrations.js swallows the "relation does not exist" error and the Health
-- check reports 'unknown — migration state unavailable' rather than failing, so
-- every other check keeps working whether or not this is applied.
-- Rollback: `drop table pr_schema_migrations;` — it holds no application data,
-- only a record of what was done, so dropping it loses knowledge and nothing
-- else.
--
-- Apply with the Supabase SQL editor or psql.

create table if not exists pr_schema_migrations (
  id          text primary key,                        -- the .sql filename, without the extension
  applied_at  timestamptz not null default now(),
  note        text                                     -- optional: who/why, for an out-of-band apply
);

comment on table pr_schema_migrations is
  'One row per applied migration from migrations/, keyed by filename without .sql. Read-only to the app; Admin -> Health reports code-expected vs recorded.';

-- Backfill the pre-ledger migrations, each gated on evidence that it ran.
do $$
begin
  -- 2026-08-02-pr-alerts.sql — created table pr_alerts
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'pr_alerts') then
    insert into pr_schema_migrations (id, note)
    values ('2026-08-02-pr-alerts', 'backfilled: pr_alerts exists')
    on conflict (id) do nothing;
  end if;

  -- 2026-08-02-pr-usage.sql — created table pr_usage
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'pr_usage') then
    insert into pr_schema_migrations (id, note)
    values ('2026-08-02-pr-usage', 'backfilled: pr_usage exists')
    on conflict (id) do nothing;
  end if;

  -- 2026-08-03-pr-subscribers-whatsapp.sql — added pr_subscribers.whatsapp
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'pr_subscribers'
               and column_name = 'whatsapp') then
    insert into pr_schema_migrations (id, note)
    values ('2026-08-03-pr-subscribers-whatsapp', 'backfilled: pr_subscribers.whatsapp exists')
    on conflict (id) do nothing;
  end if;

  -- 2026-08-06-pr-users-reset-requested-at.sql — added pr_users.reset_requested_at
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'pr_users'
               and column_name = 'reset_requested_at') then
    insert into pr_schema_migrations (id, note)
    values ('2026-08-06-pr-users-reset-requested-at', 'backfilled: pr_users.reset_requested_at exists')
    on conflict (id) do nothing;
  end if;
end $$;

-- And record this migration itself.
insert into pr_schema_migrations (id, note)
values ('2026-08-07-pr-schema-migrations', 'the ledger')
on conflict (id) do nothing;

-- RLS on, no policies: the service-role key (used by api/*.js) bypasses RLS;
-- the anon/public PostgREST role gets zero rows. Matches every other pr_ table.
alter table pr_schema_migrations enable row level security;
