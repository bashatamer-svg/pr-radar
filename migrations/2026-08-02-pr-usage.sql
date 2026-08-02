-- Migration: per-call Anthropic token accounting (backs the "API spend" and
-- "Prompt cache" health checks).
--
-- WHY: nothing in PR Radar could answer "how much has this month cost?". The
-- failure mode is silent and total — an account that hits its spend cap does not
-- warn, it starts refusing calls, and classify.js parks every story it gets no
-- verdict for as `unclassified` (hidden from the board, hidden from the brief).
-- Measured 2 Aug 2026: 100 stories parked over 7 days in bursts, with no
-- surface anywhere showing it. Recording the usage block the API already returns
-- turns the cap from something discovered by hitting it into something watched
-- on the way up.
--
-- WHAT: one row per API call. Input and output tokens are stored separately
-- because they bill at very different rates, and cached input is split out again
-- because cache WRITES cost more than fresh input while cache READS cost far
-- less — classify.js caches its system block on every batch, so collapsing them
-- would materially misstate the total, and would hide a broken cache entirely.
--
-- `stage` is the pipeline step (classify | dedupe | narrative | author | geo),
-- which is what determines the price tier: model ids come from env and change,
-- but "the first-pass screen is the cheap tier" is a property of the design.
--
-- SHARED-PROJECT SAFETY: this Supabase project also hosts another app's
-- `radar_*` tables, including its own `radar_usage`. This table is separate and
-- `pr_`-prefixed; nothing here reads, alters or drops a `radar_*` object.
--
-- SAFETY: NOT auto-applied and NOT required. lib/usage.js swallows the insert
-- failure when the table is absent, and /api/alerts degrades the two dependent
-- checks to 'unknown' — the other ten keep working. Deploy the code first,
-- confirm the pipeline is unaffected, then apply this to switch the gauge on.
-- Rollback: `drop table pr_usage;` and the code reverts to silent no-ops.
--
-- Volume is small: a few hundred calls a month at current ingest rates.
--
-- Apply with the Supabase SQL editor or psql. Idempotent.

create table if not exists pr_usage (
  id                  bigserial primary key,
  stage               text        not null,   -- classify | dedupe | narrative | author | geo
  model               text,
  input_tokens        int         not null default 0,
  output_tokens       int         not null default 0,
  cache_create_tokens int         not null default 0,   -- billed ABOVE normal input
  cache_read_tokens   int         not null default 0,   -- billed far BELOW normal input
  created_at          timestamptz not null default now()
);

create index if not exists pr_usage_created_idx on pr_usage (created_at desc);

-- RLS on, no policies: the service-role key (used by api/*.js) bypasses RLS;
-- the anon/public PostgREST role gets zero rows. Matches every other pr_ table.
alter table pr_usage enable row level security;
