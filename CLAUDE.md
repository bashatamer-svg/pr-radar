# PR Radar — project guide for Claude

Daily brand & reputation monitor for **Vodafone Egypt** (vs Orange, WE, e&).
Scans Egyptian press + Google News, AI-classifies each story (brand, tone,
reach, PR angle), and serves a live board, trends, reports, and email/WhatsApp
alerts to the PR & Communications team.

Production: `pr-radar.approvalavengers.com` (Vercel). Beta; users are being
onboarded — breakage is visible to real people.

## Hard rules (non-negotiable)

- **Shared Supabase project.** The database also hosts a SEPARATE app's
  `radar_*` tables. Touch **`pr_*` tables only** — never read, write, or
  migrate `radar_*`. Read-only diagnostic SQL via the Supabase MCP is fine;
  data-fixing writes only on the user's explicit request; **ask before any
  schema/DDL change**.
- **Zero build step, zero heavy runtime deps.** Pure ESM (`type: module`),
  plain Node on Vercel serverless, static HTML in `public/` (no framework,
  no bundler). `playwright-core` is a devDependency for tests only. Solve
  problems without adding libraries (e.g. Word export = Word-flavoured HTML;
  OG images = generated once via headless Chromium in `scripts/`).
- **Tokens in the Authorization header ONLY** — never `?t=` query params
  (they leak into logs/Referer; this was purged deliberately, don't
  reintroduce). Human auth = Supabase JWT sessions; `RADAR_TOKEN` = read-only
  service viewer; `CRON_SECRET` = service admin.
- **Fail-soft I/O.** Every new fetch/DB call gets try/catch; a broken feed or
  side-channel must never kill the pipeline. But never fail SILENTLY on the
  critical path — misconfiguration should scream in logs and response fields
  (see `bulletinSkipped`, the `sendBulletin` no-recipients throw).
- **Never fabricate content.** No invented authors (honest "newsroom"
  fallback), no invented events (classifier must not read a title-mention as
  an appointment), no numbers the data doesn't support.
- **One task = one commit**, descriptive message, test note included.
  Do NOT put the model id in commits, PRs, or code.

## Workflow

- Develop on branch `prradar/improvements`.
- **"Merge" means push to BOTH**: `claude/pr-radar-improvements-q2yxwr`
  (preview) **and** `main` (production — deploys via Vercel webhook).
- Before committing: `node --check` changed files and run `npm test`
  (must be green). Browser tests need Chromium (`CHROMIUM_PATH`, default
  sandbox path) and skip gracefully without it. `tests/README.md` maps
  what covers what; every shipped behaviour gets a regression test.

## Architecture map

- `api/*.js` — Vercel functions. `radar.js` = ingest pipeline (feeds →
  dedup layers → Haiku classify → store → alerts/bulletins/backfills);
  `stats.js` (trends + narrative clustering), `report.js` (weekly/monthly +
  custom-range reports, Word/PDF export), `admin.js`, `auth.js`, `go.js`,
  `geo.js`, `verify.js`.
- `lib/*.js` — shared logic. `db.js` (PostgREST helper `rest()` + all
  queries), `auth.js` (roles/audit), `email.js` (email-client-safe renderer:
  tables + inline styles; the weekly email output must stay byte-identical
  unless intentionally changed), `classify.js` (classifier prompt; cached
  system prompt — repeat calls read it at ~10% input price), `author.js`
  (byline extraction, see below), `resolve.js` (Google News URL decode +
  `isNonArticlePage` tag/archive guard), `report.js`, `surge.js`,
  `whatsapp.js`, `notify.js`, `geo.js`, `author-backfill.js`.
- `public/*.html` — self-contained pages (inline CSS/JS): `index` (board),
  `stats` (trends), `reports`, `admin`, `login`, `account`, `guide`,
  `context`. Session pattern: `pr_session` in localStorage + `afetch()`
  adding the Bearer; API downloads must go fetch→blob (links can't carry
  the header).
- Crons (`vercel.json`): daily full run 05:00 UTC (bulletin to `RADAR_TO` +
  subscribers), urgent poll `*/30` (severity-5 → instant email/WhatsApp),
  Monday report + GEO (both env-gated).

## Domain conventions

- Time is **Cairo days** (`Africa/Cairo`, DST-correct via Intl) for all
  user-facing windows; storage is UTC ISO.
- Author pipeline: RSS byline → page fetch → candidate collection from ALL
  sources (JSON-LD → metas → visible bylines) with **first VALID candidate
  wins** (full person validation: no emails, no UI junk, no outlet names,
  no photo credits) → AI fallback reading the article body (per-RUN budget
  `AUTHOR_AI_MAX`, reset each run — warm lambdas persist module state!).
  Admin → Tools has "Backfill authors" + "Verify verdicts" (live evidence).
- Dedup is layered: exact hash → summary hash → Jaccard clustering →
  semantic (Haiku) → pre-send digest sweep. Narrative clustering in stats.js
  is pinned against real production data (`tests/narr-fixture.mjs`).
- Vodafone-only action framing: "needs response" / "wins" lanes and KPIs are
  Vodafone-only; competitors are market intel. Analytics count everything.

## Environment notes

- Dormant env flags (OFF until configured): `REPORT_EMAIL_ENABLED`,
  `SURGE_ALERTS_ENABLED`, `SURGE_ROLLING`, `GEO_ENABLED`, `WHATSAPP_*`.
  `RADAR_TO` drives the daily bulletin + urgent emails (its absence once
  silently killed the daily brief — hence the loud guards).
- The dev sandbox has **no production secrets** and its egress proxy 403s
  arbitrary hosts: you cannot curl production APIs or news sites from here.
  Use the Supabase MCP (diagnostics), Vercel MCP (logs/deploys), Resend MCP
  (email history), or ship an admin diagnostic and let production prove it.
