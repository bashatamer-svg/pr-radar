# PR Radar — working brief for AI sessions

## Keeping this file current (do this every session)

A stale CLAUDE.md is worse than none. Update it **in the same commit** as the
change it describes. Amend or delete stale lines — this is a brief, not a
changelog. Verify every claim before adding it. Never include secrets, keys,
project refs/IDs, or model identifiers.

| If you changed… | Update section… |
|---|---|
| a table, column, or query shape | Data model |
| an env var, cron, or vercel.json | Services / Deploy flow |
| auth, tokens, roles | Hard rules |
| the author pipeline, dedup, or classifier prompt | Layout notes + Gotchas |
| email/report renderers | Gotchas (byte-identical rule) |
| test suite structure or a new test | Commands + `tests/README.md` |
| branch/deploy workflow | Deploy flow |
| found repo↔live drift | Drift table |

Enforced narrowly: a Stop hook (`.claude/settings.json`) blocks ending a
session when `vercel.json`, `schema.sql`, `package.json`, or `lib/auth.js`
changed without a CLAUDE.md update — those four almost always invalidate this
brief. Everything else relies on the table above.

## What this is

Daily brand & reputation monitor for **Vodafone Egypt** (vs Orange, WE, e&).
Scans Egyptian press + Google News RSS, AI-classifies each story (brand, tone,
reach 1–5, PR angle), serves a live board / trends / date-range reports, and
sends email + WhatsApp alerts. Pure ESM Node on Vercel serverless + Supabase
(PostgREST) + Resend. No framework, no build step. Production:
`pr-radar.approvalavengers.com` — beta with real users.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Full suite (tests/run.mjs, one process per file). **Must be green before every commit.** |
| `npm test -- <substr>` | Only tests whose filename matches |
| `node --check <file>` | Syntax-check every changed file before commit |
| `node scripts/make-og.mjs` | Regenerate OG card + favicon (only after redesigning them) |

Browser tests need Chromium (`CHROMIUM_PATH`, default sandbox path) and skip
gracefully without it. `tests/README.md` maps what covers what. Every shipped
behaviour gets a regression test in the same commit.

## Layout — where logic belongs

| Path | What lives here |
|---|---|
| `api/*.js` | Vercel functions only. `radar.js` = ingest pipeline (feeds → dedup → classify → store → alerts/bulletins/backfills); `stats.js` trends aggregation (narratives live in `lib/narratives.js`); `report.js` weekly/custom reports + Word export; `admin.js`, `auth.js`, `go.js`, `geo.js`, `verify.js` |
| `lib/*.js` | ALL shared logic. `sources.js` (feeds + the direct-feed relevance prefilter), `feed-candidates.js` (STAGING only — probe before promoting), `db.js` (PostgREST `rest()` + every query), `auth.js` (roles/audit), `email.js` (email-client-safe renderer), `classify.js` (classifier prompt, cached system block), `author.js` (byline extraction), `author-backfill.js`, `resolve.js` (Google-News decode + `isNonArticlePage`), `narratives.js` (two-stage narrative clustering), `report.js`, `surge.js`, `whatsapp.js`, `notify.js`, `geo.js` |
| `public/*.html` | Self-contained pages (inline CSS/JS, no imports). Session = `pr_session` in localStorage + `afetch()` Bearer wrapper. API downloads must go fetch→blob (links can't carry the header) |
| `scripts/` | One-off generators run manually (OG images) |
| `tests/*.mjs` | The suite. `narr-fixture.mjs` is captured production data, not a test |

New shared behaviour goes in `lib/` and is imported by `api/`; never duplicate
logic into a function file. New pages get a rewrite in `vercel.json`.

## Services

| Cron (vercel.json) | Schedule (UTC) | Notes |
|---|---|---|
| `/api/radar` | daily 05:00 | full run: ingest + daily bulletin (`RADAR_TO` + subscribers) + stored-author backfill |
| `/api/radar?urgentOnly=1` | every 30 min | ingest + severity-5 instant email/WhatsApp; skips bulletin |
| `/api/report?period=week&send=1` | Mon 06:00 | no-op unless `REPORT_EMAIL_ENABLED=1` |
| `/api/geo?send=1` | Mon 07:00 | no-op unless `GEO_ENABLED=1` |

Sources (`lib/sources.js`): 10 brand/market Google-News queries (AR+EN) + 7
site-scoped sweeps covering the team's named outlet list + 13 direct outlet RSS
feeds (the only ones that carry a byline) = 30 daily. The 30-min urgent poll
runs the 10 brand queries only. Direct feeds are probe-verified; 31 unverified
candidates remain staged in `lib/feed-candidates.js`.

Integrations: Supabase (service-role key, PostgREST), Anthropic (classifier +
byline fallback), Resend (all email), WhatsApp Cloud API (dormant until
`WHATSAPP_*` set — official API cannot post to groups, DMs only).

Dormant env flags (OFF until configured): `REPORT_EMAIL_ENABLED`,
`SURGE_ALERTS_ENABLED`, `SURGE_ROLLING`, `GEO_ENABLED`, `WHATSAPP_*`.

## Data model (`pr_*` tables — live-verified)

| Table | Role |
|---|---|
| `pr_items` | One story card. `author` NULL (never '') = shown as newsroom; `is_relevant=false` = hidden everywhere; `team_share` tri-state (true pin / false hide / null algorithm); `importance` 1–5 |
| `pr_instances` | Every outlet that ran the story (coverage spread), FK → items |
| `pr_users` / `pr_audit` | Sign-in allowlist + roles; audit trail. **Live-only: missing from schema.sql** (see Drift) |
| `pr_state` | Key/timestamp markers (`daily_bulletin_sent` idempotency) |
| `pr_subscribers` | Daily-digest mailing list (categories[] filter; ≠ users) |
| `pr_context` | Admin-editable house knowledge injected into classification |
| `pr_feed_health` | Per-feed failure streaks (bulletin footer) |
| `pr_feedback` | In-app feedback form |

RLS is ON with **no policies**: only the service-role key reads/writes; anon
gets nothing. All queries live in `lib/db.js`.

## Hard rules (non-negotiable)

- **Shared Supabase project** with a separate app's `radar_*` tables. Touch
  `pr_*` ONLY. Read-only diagnostic SQL via MCP is fine; data-fix writes only
  on explicit user request; **ask before any schema/DDL change**.
- **Zero build step, zero heavy runtime deps** (only `fast-xml-parser`;
  `playwright-core` is dev-only). Solve without adding libraries.
- **Tokens in the Authorization header ONLY** — never `?t=` (deliberately
  purged; don't reintroduce). `RADAR_TOKEN`=viewer, `CRON_SECRET`=admin,
  humans = Supabase JWT.
- **Fail-soft I/O, never silent on the critical path** — try/catch every
  fetch/DB call, but misconfiguration must scream (`bulletinSkipped`,
  `sendBulletin` throws on empty recipients).
- **Never fabricate** — no invented authors (newsroom fallback), no invented
  events (a title-mention is not an appointment), no unsupported numbers.
- One task = one commit, descriptive message + test note. No model ids in
  commits/PRs/code.

## Deploy flow

- Develop on `prradar/improvements`. **"Merge" = push to BOTH**
  `claude/pr-radar-improvements-q2yxwr` (preview) **and** `main`
  (production — auto-deploys via Vercel webhook, ~1–2 min).
- Does NOT ship with a deploy: env vars (Vercel dashboard only), DB schema
  (manual SQL, ask first), OG images (committed PNGs; regenerate by script).

## Drift (repo ↔ live, verified 2026-07-30)

| Where | Fact |
|---|---|
| `schema.sql` | Missing `pr_users` + `pr_audit` (created ad-hoc in prod). Add them (idempotently) next time schema.sql is touched — with user approval |
| Vercel env | `RADAR_TO` was unset → daily brief + urgent emails silently dead 22–30 Jul. Code now fails loud; the var must still be set in the dashboard |
| `api/radar.js` comments | Mention a 04:10 GitHub Actions backup cron — no workflow exists in this repo (unconfirmed origin) |

## Gotchas (each cost real debugging time)

- **Warm lambdas persist module state.** Any counter/cache at module scope
  survives between invocations — the AI byline budget must be reset per run
  (`resetAuthorAiBudget()`); think before adding module-level state.
- **This sandbox cannot reach production or news sites** (egress proxy 403s
  arbitrary hosts) and has no production secrets. Verify via Supabase/Vercel/
  Resend MCPs, or ship an admin diagnostic (pattern: Tools → "Verify
  verdicts") and let production prove it.
- **Never add a feed URL unprobed.** A 404 fails silently and the radar looks
  calm while blind. Candidates live in `lib/feed-candidates.js`; Admin → Tools
  → "Probe feeds" verifies them FROM PRODUCTION (the sandbox has no egress to
  news hosts), then a verified URL moves into `DIRECT_FEEDS`.
- **Direct outlet feeds are prefiltered** (`isWorthClassifying`): a national
  daily's firehose is mostly football/crime, and every item would otherwise cost
  a classifier call. Query-scoped Google-News feeds bypass the filter; sector
  stories naming no brand still pass it.
- **Author extraction is first-VALID-wins** across all sources (JSON-LD →
  metas → visible bylines) — junk in a high source must never mask a lower
  real byline. Junk classes already filtered: outlet names, UI placeholders,
  emails, photo credits (تصوير/أرشيفية). Tag/keyword/search archive URLs are
  killed at ingest (`isNonArticlePage`).
- **The weekly email output must stay byte-identical** unless intentionally
  changed — `buildReportRange` was added *beside* `buildReport` for this
  reason. Email HTML is table-layout + inline styles only.
- **One design system across surfaces.** `lib/email.js` carries the BOARD's
  tokens (`public/index.html` `:root`) and exports them as `THEME` for
  `lib/report.js`, so bulletin + urgent + report + board match. Change a board
  token → update the email constants in the same commit (`render-email-design`
  reads `:root` and fails otherwise). Card vocabulary is shared too: Reach,
  "What to do with this", and the lane names Needs a response / Wins to
  amplify / Market & noted.
- **Inline styles sit inside `style="…"`** — never use double quotes within a
  declaration (a `"Segoe UI"` in the font stack truncated every property after
  it and silently killed colours). Single quotes only; the test guards it.
- **Narratives are two-stage** (`lib/narratives.js`): a deterministic token
  pre-pass, then an LLM pass (Haiku, `NARRATIVE_MODEL`) that re-groups and
  writes the English title. Stage 2 is fail-soft and optional — no
  `ANTHROPIC_API_KEY`, a timeout (12s), a malformed reply or an id it invented
  and stage 1's answer stands, so the section always renders. Model output is
  untrusted: ids are validated against the input, duplicates and <2-story groups
  dropped. Memoised in module scope per (window, exact id set) — warm-lambda
  persistence used deliberately here; `_resetNarrativeCache()` for tests.
  Token overlap alone can't separate two stories that share PR vocabulary (an
  ad campaign vs a plagiarism row about its music) — that's the LLM's job; the
  fallback deliberately errs toward splitting, since a false merge reports one
  number for two unrelated things.
- **Narrative clustering is pinned to real production data**
  (`tests/narr-real.mjs` + fixture, recaptured 2026-07-31, 100 rows). If it
  fails after a change, the change broke clustering — don't "fix" the fixture;
  recapture it from `pr_items` if the data genuinely moved on.
- **A narrative's `ids` ARE the board view.** Trends counts a cluster's stories,
  but tapping the row opens the board by fetching exactly those ids — so any cap
  on the id list silently shows fewer cards than the row promised (a 27-story
  narrative opened as 20 and dropped its only negative, live-reported
  2026-07-31). `NARR_IDS_MAX` in `api/stats.js` must stay ≤ the cap inside
  `itemsByIds()` (`lib/db.js`, currently 100); the list is ordered by importance
  so a cluster past that cap keeps its biggest stories, and the true count rides
  along as `&n=` so the board banner reads "top N of M" instead of under-
  reporting. Pinned by `render-narrative-cluster` + `render-deeplink`.
  General rule: a cap that changes what the user sees must be visible in the UI.
- **The Trends leaderboards are PAGED, 15 a page** — `/api/stats` ships the full
  outlet + journalist lists (backstop cap 300 each) and `stats.html` slices them
  client-side, so flipping costs no request and never re-runs the narrative LLM
  pass. Page state is `pageOf` and MUST reset in `load()`, or a window change
  strands you on a page that no longer exists. Bar widths scale to the busiest
  row in the WHOLE list, not the page. The ⊞ Table view shows the same page.
  Only about half of stories carry an individual byline — Egyptian wire/desk
  copy is unsigned — so the journalist count is always far below the story
  count; `totals.itemsWithByline` powers the footnote that says so. Pinned by
  `render-leaderboard-pages` + `render-trends-wording`.
- **Cairo days** (`Africa/Cairo`, DST via Intl) for every user-facing window;
  storage is UTC ISO. Board/stats/report windows must reconcile.
- Vodafone-only action framing: needs-response/wins lanes + those KPIs are
  Vodafone-only; competitors are market intel; analytics count everything.
- **Sentiment is the story's own tone for the brand it names** — the identical
  scale on all four brands, **never inverted**. A rival's award is stored
  `positive` (good for them), a rival's outage `negative`. What a competitor
  story means for US is carried by **severity** (that axis IS Vodafone-centred,
  by design) and by the **lane** (needs-response / wins are Vodafone-only), never
  by this field; sector spillover goes in `pr_angle`. Every surface names it
  plainly **Negative / Neutral / Positive** — competitor pills are not
  relabelled. Superseded (2026-07-31, user decision) an earlier Vodafone-
  standpoint convention that stored a rival's win as `negative`; the
  "Competitor win / setback / note" pills and the "unfavourable / favourable"
  wording existed only to make that inversion readable and are **retired** —
  don't reintroduce either. 10 historical competitor rows were re-scored in
  `pr_items` in the same change. Competitor wins sitting at `neutral`
  (understated, not inverted) were left as-is. Pinned by `render-lanes`,
  `render-lanes-email-report`, `render-trends-wording`.
- WhatsApp preview caches are sticky — test OG changes with a `?v=N` URL.

## Verifying work

1. `node --check` changed files; `npm test` green (browser tests need Chromium).
2. Pipeline changes: `/api/radar?dry=1` (no side effects), `?debug=1`
  (per-story funnel trace), `?to=you@x` (real daily send to one address).
3. Author work: Admin → Tools → "Backfill authors" + "Verify verdicts"
  (live per-card evidence: outcome, page text, per-profile fetch statuses).
4. After deploy: Vercel MCP (runtime logs), Resend MCP (did mail send),
  Supabase MCP read-only SQL (did rows change). `pr_state.daily_bulletin_sent`
  tells you when the brief last actually went out.
