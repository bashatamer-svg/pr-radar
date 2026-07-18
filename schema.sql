-- PR Radar — Supabase schema (brand & reputation monitor for the PR team).
--
-- IMPORTANT — shared-project safety:
-- This app is designed to run in the SAME Supabase project as the Regulatory
-- Radar WITHOUT touching it. Every object here is prefixed `pr_`. This file
-- NEVER references, alters, or re-creates any `radar_*` table, so applying it to
-- the Regulatory Radar's project only ADDS the pr_* tables and leaves the
-- regulatory data completely untouched. Safe to re-run (idempotent).

-- One story the PR team should see = one row here (the "card").
create table if not exists pr_items (
  id            bigserial primary key,
  hash          text unique not null,          -- sha256 of the normalised headline
  headline      text not null,
  url           text not null,                 -- primary link (cleaned to the publisher URL when resolvable)
  source        text,                          -- primary outlet / feed name ("who published it")
  author        text,                          -- primary byline; NULL (shown as "—") when none / unfetchable
  published_at  timestamptz,
  seen_at       timestamptz not null default now(),

  -- classifier output (sentiment / reputation, not regulatory materiality)
  brand         text,                          -- 'Vodafone' | 'Orange' | 'WE' | 'e&' | 'market'
  sentiment     text,                          -- 'negative' | 'neutral' | 'positive' (from Vodafone Egypt's standpoint)
  country       text,                          -- 'Egypt'
  category      text,                          -- network | pricing | customer_service | vodafone_cash | data_privacy | campaign | corporate | competitor | other
  summary       text,                          -- one-line canonical paraphrase (dedup key)
  pr_angle      text,                          -- 3-line reputational brief: Read / Audience / Action
  importance    smallint,                      -- 1..5 severity (reputational reach/impact)
  confidence    real,                          -- 0..1
  is_relevant   boolean default true,
  deadline      date,                          -- rare; a concrete date the team must act on, else NULL

  -- board plumbing
  feedback      smallint,                      -- -1 bad, +1 good, null untouched (tuning loop)
  team_share    boolean,                       -- admin pin (true) / hide (false) / null = follow algorithm
  team_share_at timestamptz,                   -- when the admin pinned/unpinned
  summary_hash  text,                          -- normalised hash of the paraphrase, for cross-language dedup
  resolved_url  text                           -- real publisher URL decoded from a Google-News wrapper; pre-filled at insert so /api/go shares are instant
);

create index if not exists pr_items_sentiment_idx  on pr_items (sentiment, importance desc, seen_at desc) where is_relevant;
create index if not exists pr_items_brand_idx       on pr_items (brand);
create index if not exists pr_items_seen_idx        on pr_items (seen_at desc);
create index if not exists pr_items_summary_hash_idx on pr_items (summary_hash);

-- pr_instances — every outlet that ran a story. A PR team needs coverage spread:
-- 8 outlets carrying a negative story matters more than 1. The pipeline keeps the
-- best cluster member as the pr_items "card" and writes EVERY member here as an
-- instance (outlet · author · url · date). One card -> many instances.
create table if not exists pr_instances (
  id            bigserial primary key,
  item_id       bigint not null references pr_items(id) on delete cascade,
  outlet        text,          -- publisher / feed name (who published it)
  author        text,          -- byline where available, else null
  url           text not null, -- the specific outlet's link to the story
  published_at  timestamptz,
  seen_at       timestamptz not null default now(),
  unique (item_id, url)        -- don't double-count the same outlet link
);
create index if not exists pr_instances_item_idx on pr_instances (item_id);

-- Single-row-per-key state markers (e.g. the once-per-day 'daily_bulletin_sent'
-- idempotency guard). SEPARATE from RR's radar_state, so the two apps' daily
-- sends can never cross-suppress each other.
create table if not exists pr_state (
  key         text primary key,
  updated_at  timestamptz not null default now()
);

-- Admin-editable "living PR knowledge" (current campaigns, live issues, a
-- spokesperson change) injected into every classification. Edited via a context
-- page, no redeploy. Fail-open if empty/unreachable.
create table if not exists pr_context (
  key        text primary key,   -- e.g. 'house_knowledge'
  content    text,
  updated_at timestamptz not null default now()
);

-- Per-feed health, so silent scraper rot shows up in the bulletin footer.
create table if not exists pr_feed_health (
  feed_id     text primary key,
  last_ok_at  timestamptz,
  last_error  text,
  fail_streak int not null default 0
);

-- Watchlist subscribers — team members who want their own filtered digest.
-- `categories` is an array of classifier category slugs; NULL/empty = "all".
create table if not exists pr_subscribers (
  id          bigserial primary key,
  email       text unique not null,
  name        text,
  categories  text[],
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Board feedback form — bug reports / ideas / questions from the team.
create table if not exists pr_feedback (
  id          bigserial primary key,
  message     text not null,
  kind        text,           -- bug | idea | question | null
  name        text,
  email       text,
  page        text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  resolved    boolean not null default false
);

-- Row-Level Security ON, NO policies — the app reaches Supabase only with the
-- service-role key (which bypasses RLS); the anon/public role gets zero rows.
-- Matches the Regulatory Radar's posture. Idempotent.
alter table pr_items       enable row level security;
alter table pr_instances   enable row level security;
alter table pr_state       enable row level security;
alter table pr_context     enable row level security;
alter table pr_feed_health enable row level security;
alter table pr_subscribers enable row level security;
alter table pr_feedback    enable row level security;
