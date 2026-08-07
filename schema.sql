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

-- ═══════════════════════════════════════════════════════════════════════════
-- Everything below was created ad-hoc in production and was MISSING from this
-- file — a documented drift that meant `schema.sql` could not rebuild a working
-- database. Reconstructed 2026-08-07 from the live catalogue (read-only
-- information_schema / pg_indexes / pg_constraint query), not from memory, so
-- the definitions match production exactly rather than approximately.
--
-- Two details are easy to get wrong by writing what "looks right": pr_users.id
-- and pr_audit.id are IDENTITY columns in production, not bigserial, and
-- pr_users carries a CHECK on role. Both are reproduced as they actually are.
-- ═══════════════════════════════════════════════════════════════════════════

-- Sign-in allowlist + roles. An allowlist row is only HALF an account: the
-- PASSWORD lives in Supabase Auth (auth.users), and Admin → Users writes both.
-- A row here is what GRANTS access; deactivating it revokes access without
-- deleting the person's auth account or their audit history.
create table if not exists pr_users (
  id                 bigint generated always as identity primary key,
  email              text not null unique,
  role               text not null default 'viewer' check (role in ('admin', 'viewer')),
  name               text,
  active             boolean not null default true,
  invited_by         text,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),
  -- Forgot-password queue. Set when someone taps "Forgot password?" on the
  -- sign-in screen; cleared automatically by EVERY path that sets a password,
  -- so the queue empties itself. NULL = nothing outstanding.
  -- (Was migrations/2026-08-06-pr-users-reset-requested-at.sql; applied.)
  reset_requested_at timestamptz
);
-- Partial: the queue only ever asks for the handful of non-null rows, so
-- indexing just those keeps it at roughly zero pages.
create index if not exists pr_users_reset_requested_idx
  on pr_users (reset_requested_at) where reset_requested_at is not null;

-- Who did what. Every privileged action writes one row: sign-ins, role changes,
-- pins/hides, manual alerts, password resets. `detail` is jsonb for the shape
-- of the action; a CREDENTIAL NEVER GOES IN IT — an audit row is long-lived
-- storage, and a generated password belongs only in the response to the admin
-- who asked for it.
create table if not exists pr_audit (
  id          bigint generated always as identity primary key,
  actor       text,          -- email, or 'service:cron' / 'service:token'
  actor_role  text,          -- admin | viewer
  action      text not null, -- user.add | item.pin | alert.manual | radar.run | …
  target      text,
  detail      jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists pr_audit_created_idx on pr_audit (created_at desc);

-- Persisted alert history (Admin → Health, "Recent alerts").
-- From migrations/2026-08-02-pr-alerts.sql; applied.
create table if not exists pr_alerts (
  id          bigserial primary key,
  kind        text        not null default 'ops',   -- ops | classify | budget | …
  severity    text        not null default 'warn',  -- info | warn | critical
  title       text        not null,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists pr_alerts_created_idx on pr_alerts (created_at desc);

-- Per-call Anthropic token accounting (the "API spend" and "Prompt cache"
-- health checks). Input and output are separate because they bill at very
-- different rates, and cached input is split again because cache WRITES cost
-- more than fresh input while cache READS cost far less — collapsing them
-- would misstate the total and hide a broken cache entirely.
-- From migrations/2026-08-02-pr-usage.sql; applied.
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

-- The WhatsApp crisis number, on the subscriber rather than in an env var —
-- WHATSAPP_TO needed a dashboard edit AND a redeploy, so in practice it never
-- changed. NULL (never '') = this person gets no WhatsApp alerts, the same
-- convention pr_items.author uses for "no byline". `active` gates BOTH channels.
-- From migrations/2026-08-03-pr-subscribers-whatsapp.sql; applied.
alter table pr_subscribers add column if not exists whatsapp text;

alter table pr_users   enable row level security;
alter table pr_audit   enable row level security;
alter table pr_alerts  enable row level security;
alter table pr_usage   enable row level security;
