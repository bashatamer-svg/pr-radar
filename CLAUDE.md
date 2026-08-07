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
| a health check or one of its thresholds | Gotchas (they are calibrated to live numbers — re-verify, don't guess) |
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
Impact 1–5, PR angle), serves a live board / trends / date-range reports, and
sends email + WhatsApp alerts. Pure ESM Node on Vercel serverless + Supabase
(PostgREST) + Resend. No framework, no build step. Production:
`pr-radar.approvalavengers.com` — beta with real users.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Exact install from the tracked `package-lock.json`. What CI runs — prefer it over `npm install`. |
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
| `api/*.js` | Vercel functions only. `radar.js` = ingest pipeline (feeds → dedup → classify → store → alerts/bulletins/backfills); `stats.js` trends aggregation (narratives live in `lib/narratives.js`); `report.js` weekly/custom reports + Word export; `alerts.js` (pipeline health checks + the daily push); `admin.js`, `auth.js`, `go.js`, `geo.js`, `verify.js` |
| `lib/*.js` | ALL shared logic. `xml.js` (the ONLY place `fast-xml-parser` is constructed — hostile-feed guards), `safe-url.js` (the ONE scheme allowlist for third-party links), `sources.js` (feeds + the direct-feed relevance prefilter), `feed-candidates.js` (STAGING only — probe before promoting), `db.js` (PostgREST `rest()` + every query), `auth.js` (roles/audit + `provisionUser`/`generateTempPassword`/`adminCreateUser`), `email.js` (email-client-safe renderer + `renderWelcome` + `sendOpsAlert`), `classify.js` (classifier prompt, cached system block), `author.js` (byline extraction), `author-backfill.js`, `resolve.js` (Google-News decode + `isNonArticlePage`), `dedupe.js` (shared tokenize/jaccard + the admin duplicate-finder), `dedupe-semantic.js`, `narratives.js` (two-stage narrative clustering), `report.js`, `surge.js`, `whatsapp.js`, `notify.js`, `geo.js`, `usage.js` (per-call token accounting), `deliverability.js` (provider-side send status) |
| `public/*.html` | Self-contained pages (inline CSS/JS) for everything a page OWNS — its markup, styles and behaviour. API downloads must go fetch→blob (links can't carry the header) |
| `public/assets/session.js` | The ONE session implementation: `session`, `saveSession`, `signOut`, `captureSessionFromHash`, `authConfig`, `refreshSession`, `afetch`. Loaded as a classic script BEFORE each page's inline block (not `defer` — the inline code calls into it at parse time). Authentication is not something a page owns |
| `migrations/*.sql` | Optional, **manually applied**, each with a WHY/WHAT/SAFETY header. Never auto-applied — the code must work without them |
| `scripts/` | One-off generators run manually (OG images) |
| `tests/*.mjs` | The suite. `narr-fixture.mjs` (captured production data) and `byline-cases.mjs` (the byline ledger) are DATA, not tests — both are in the runner's `EXCLUDE` |

New shared behaviour goes in `lib/` and is imported by `api/`; never duplicate
logic into a function file. New pages get a rewrite in `vercel.json`.

## Services

| Cron (vercel.json) | Schedule (UTC) | Notes |
|---|---|---|
| `/api/radar` | daily 05:00 | full run: ingest + daily bulletin (`RADAR_TO` + subscribers) + stored-author backfill |
| `/api/radar?urgentOnly=1` | every 15 min | ingest + instant email/WhatsApp for anything `isInstantAlert` (Impact 4-5, or any negative story about a tracked operator); skips bulletin |
| `/api/report?period=week&send=1` | Mon 06:00 | no-op unless `REPORT_EMAIL_ENABLED=1` |
| `/api/geo?send=1` | Mon 07:00 | no-op unless `GEO_ENABLED=1` |
| `/api/alerts?notify=1` | daily 05:45 | health push — silent unless a check is warn/crit, and deduped on the subject so a chronic problem mails once, not daily |

Sources (`lib/sources.js`): 10 brand/market Google-News queries (AR+EN) + 6
site-scoped sweeps covering the team's named outlet list + 14 direct outlet RSS
feeds (the only ones that carry a byline) = 30 daily. The four operator
domains are deliberately NOT sources (user decision 5 Aug — their pages are
stores, promos and share cards, not news; pinned by `render-prefilter`). The 15-min urgent poll
runs the 10 brand queries only. Direct feeds are probe-verified; **3** unverified
candidates remain staged in `lib/feed-candidates.js`. The 3 Aug probe promoted
exactly ONE of 31 (Aitnews, 10/10 bylined) and DISPROVED 28 — 22 that 404/403'd
and 7 whose URL served an HTML page — so those were retired from the staging
file rather than re-probed forever; all are still swept by a `site:` query in
SITE_FEEDS, so what was lost is the byline, not the coverage. Treat another
sweep of guessed `/rss` and `/feed` suffixes as low-yield. The one live lead is
**Youm7**: `SectionRss?SectionID=0` returned a valid RSS document with zero
items, so the endpoint shape is right and only the section id is wrong.

Integrations: Supabase (service-role key, PostgREST), Anthropic (classifier +
byline fallback + narrative grouping), Resend (all email), WhatsApp Cloud API
(`WHATSAPP_*` SET in Vercel against the new **PR Radar** WABA — sends reach Meta
but are refused with `#131037` — `pr_urgent` IS APPROVED (4 Aug) and the display
name passes (`AVAILABLE_WITHOUT_REVIEW`), so the blocker is the sender itself:
a Meta-provisioned `+1 555` TEST number that only reaches pre-registered
recipients. Registering a real business number is the remaining step (see the
WhatsApp Gotcha). The official API cannot post
to groups, DMs only. Recipients = `pr_subscribers.whatsapp` ∪ `WHATSAPP_TO`).

Optional tuning vars (sane defaults, set only to override): `CLASSIFIER_MODEL`,
`NARRATIVE_MODEL` (falls back to `CLASSIFIER_MODEL`), `NARRATIVE_TIMEOUT_MS`
(12000 — the ceiling on the Trends LLM pass, since /api/stats is a page load).

Dormant env flags (OFF until configured): `REPORT_EMAIL_ENABLED`,
`SURGE_ALERTS_ENABLED`, `SURGE_ROLLING`, `GEO_ENABLED`.

## Data model (`pr_*` tables — live-verified)

| Table | Role |
|---|---|
| `pr_items` | One story card. `author` NULL (never '') = shown as newsroom; `is_relevant=false` = hidden everywhere; `team_share` tri-state (true pin / false hide / null algorithm); `importance` 1–5 |
| `pr_instances` | Every outlet that ran the story (coverage spread), FK → items |
| `pr_users` / `pr_audit` | Sign-in allowlist + roles; audit trail. **Live-only: missing from schema.sql** (see Drift). The row is only half an account — the PASSWORD lives in Supabase Auth, and Admin → Users writes both (see the provisioning Gotcha) |
| `pr_state` | Key/timestamp markers (`daily_bulletin_sent` idempotency; `manual_alert_<id>` = the board's 🔔 already fired for that card) |
| `pr_subscribers` | Daily-digest mailing list (categories[] filter; ≠ users). `whatsapp` NULL (never '') = not paged; `active` gates BOTH channels. `addSubscriber` UPSERTS every column, so ask `getSubscriberByEmail` first or you blank a live row's filter and crisis number |
| `pr_context` | Admin-editable house knowledge injected into classification. **It decays, and now says so**: a line naming a live story is right for a fortnight and then steers unrelated news, and nothing ever prompted a prune. `houseContextCheck` warns on a **dated** entry (`[YYYY-MM-DD]` line prefix, an optional convention) older than 45 days, or on the whole doc going 60 days untouched. Undated lines are deliberately NOT flagged — flagging them would make the check permanently amber on the doc as it stands, which is how a check stops being read. **In use since 5 Aug** (one `house_knowledge` row): an "ONGOING STORIES" list naming connections the headlines withhold — the توليت song is a Vodafone ad's music; the Inas Ezzeddin 5-lines case is against Vodafone. This is where story-specific facts belong; the PROMPT carries the general rules. Prune a line when its story dies, or it will eventually mis-tag unrelated news |
| `pr_feed_health` | Per-feed failure streaks (bulletin footer). **`fail_streak` never counted** — `recordFeedHealth` wrote a literal `1` on every failure, so a feed dead three weeks read like one that hiccuped once. It cannot be a read-then-write: the 15-min poll and the 05:00 run OVERLAP on the ten brand feeds, so two writers read the same number and both write value+1. PostgREST cannot express `set x = x + 1` either, so the increment goes through **`pr_bump_feed_failure`** (`migrations/2026-08-07-pr-feed-failure-streak.sql`, **NOT yet applied**) — one `INSERT..ON CONFLICT DO UPDATE`, atomic by construction. Without it the fallback records the error and **leaves the count alone** rather than resetting it to 1: stale is honest, `1` actively asserts something false. `last_ok_at` is never touched by a failure — it is what `brokenFeeds()` actually reads. Pinned by `verify-feed-streak` |
| `pr_feedback` | In-app feedback form |
| `pr_alerts` / `pr_usage` | Alert history + per-call token accounting (Admin → Health). **Applied 2 Aug** via Supabase MCP with user approval, from `migrations/2026-08-02-*.sql` |
| `pr_subscribers.whatsapp` | **Applied 3 Aug** via Supabase MCP with user approval, from `migrations/2026-08-03-pr-subscribers-whatsapp.sql` |
| `pr_schema_migrations` | **Which migrations this database has.** Nothing recorded it before, which is how this file spent a week asserting `reset_requested_at` was un-applied when it was live — a wrong belief about schema state sends a reader hunting a bug in correct code. `lib/migrations.js` holds the code's side (`MIGRATIONS`, id = filename without `.sql`); the table is the DB's side; Admin → Health shows them together. **READ-ONLY to the app** — a migration is a human action taken with approval, and an app that can record or perform its own schema changes changes production while nobody watches. **NOT yet applied** (`migrations/2026-08-07-pr-schema-migrations.sql`); it BACKFILLS on evidence (each pre-ledger entry is inserted only if its object actually exists), so applying it states what is true rather than assuming a clean slate |
| `pr_runs` | **Did the job actually RUN?** Every "did it run?" check on Health was an INFERENCE from an outcome, and "no new stories in 20h" is equally consistent with a quiet night, with every story being a duplicate (the 15-min poll writes nothing then), and with the cron never firing. One row per run: start, finish, status, duration, counts, first line of any error, and the `git_sha` that ran it. A row left `running` with a null `completed_at` is a run the **function timeout killed** — the one failure no outcome-based check can see, since it writes nothing and throws nothing. **NOT yet applied** (`migrations/2026-08-07-pr-runs.sql`) |
| `pr_users.reset_requested_at` | Forgot-password queue: set when someone taps "Forgot password?", cleared by EVERY path that sets a password, so the queue empties itself. **APPLIED — live-verified 7 Aug** (this file previously said "NOT yet applied"; the column and its partial index are both present). The code still degrades gracefully without it, and that fallback is still tested |

RLS is ON with **no policies**: only the service-role key reads/writes; anon
gets nothing. All queries live in `lib/db.js`.

## Hard rules (non-negotiable)

- **Shared Supabase project** with a separate app's `radar_*` tables. Touch
  `pr_*` ONLY. Read-only diagnostic SQL via MCP is fine; data-fix writes only
  on explicit user request; **ask before any schema/DDL change**.
- **Zero build step, zero heavy runtime deps** (only `fast-xml-parser`;
  `playwright-core` is dev-only). Solve without adding libraries.
  **`package-lock.json` is tracked** — it used to be gitignored, so every
  install resolved the XML parser afresh and `npm audit` had nothing stable to
  judge. Change a dependency ⇒ commit the lockfile in the same commit.
- **Tokens in the Authorization header ONLY** — never `?t=` (deliberately
  purged; don't reintroduce). `RADAR_TOKEN`=viewer, `CRON_SECRET`=admin,
  humans = Supabase JWT.
  **And the viewer token cannot OPERATE.** `/api/radar` and `/api/geo` each
  carried their OWN inline `safeEqual` pair accepting either token, so the
  SHARED read-only `RADAR_TOKEN` could fire a full ingest — thirty feed fetches,
  a round of paid classifier calls, the daily brief to every subscriber, the
  WhatsApp crisis numbers. Both now call **`requireOperator`** (`lib/auth.js`),
  which is `requireRole(…, 'admin')` under a name that states the policy at the
  call site. Read-only is judged by EFFECT: `?dry=1` stores nothing but still
  spends, so it is gated too. **A manual radar/geo run therefore needs
  `CRON_SECRET` or a signed-in admin session — `RADAR_TOKEN` answers 403.**
  Human-triggered runs are audited as `radar.run`; the cron's are not (every 15
  minutes, and `pr_state` already records what they delivered). Pinned by
  `verify-token-privilege`, which asserts every principal × endpoint cell
  INCLUDING the must-nots, that a refusal happens before any feed is fetched or
  mail sent, that `RADAR_TOKEN` still READS `/api/stats` and `/api/items`, and
  that no file in `api/` reads `process.env.RADAR_TOKEN` again. The server has enforced this since Task 18, but four
  pages kept a client-side `authURL()` appending `?t=` alongside a `const
  token=''` that made every branch dead — removed 3 Aug. `render-notoken` now
  reads every `public/*.html` and fails on `authURL(`, `const token =`, or a
  `?t=${…}` construction, so the shape cannot return.
- **Fail-soft I/O, never silent on the critical path** — try/catch every
  fetch/DB call, but misconfiguration must scream (`bulletinSkipped`,
  `sendBulletin` throws on empty recipients).
- **Never fabricate** — no invented authors (newsroom fallback), no invented
  events (a title-mention is not an appointment), no unsupported numbers.
- **A generated credential goes to the requesting admin in the RESPONSE, and
  nowhere else** — never into `pr_audit` (long-lived storage), never into a log
  line, never into an email addressed to anyone but its owner.
- One task = one commit, descriptive message + test note. No model ids in
  commits/PRs/code.

## Deploy flow

**PR-based since the CI gate landed.** Feature branch → pull request → CI green
→ merge to `main` → Vercel deploys production → verify the running SHA.

- **Develop on a `claude/<topic>-<id>` branch.** Never push to `main` directly:
  `main` deploys to production on push, with real users on the live board, so a
  direct push is an unreviewed, untested production deploy. (Earlier sessions
  did push both branch and `main`; that is what this flow replaces.)
- **CI** (`.github/workflows/ci.yml`) runs on every PR and on pushes to `main`
  and `claude/**`: `npm ci`, `node --check`, JSON validation, Chromium install,
  `npm test` with **`CI=true`** — which makes a SKIPPED browser test a FAILED
  run. Half the suite drives Chromium (every mobile-layout regression, the auth
  UI, the CSP proof), and a green run that exercised none of them is worse than
  a red one. Plus a runtime-only `npm audit` in a separate job, so a dev-only
  advisory cannot block a correct change. Pinned by `verify-ci-gate`.
- **CI running is not CI mattering.** Nothing in a repository forces a check to
  pass or a change through a PR — that is branch protection, which lives in
  GitHub settings and cannot be committed. The exact list is
  **`docs/REPOSITORY_SETTINGS.md`**, flagged NOT VERIFIED until an owner ticks
  it off. Do not claim protection is on without checking.
- **A push to `main` is not proof of a deploy.** The webhook silently missed
  `9e3fcc7` (3 Aug): `git ls-remote` showed `main` at the new SHA, the BRANCH
  preview built, and no production build was ever created — so the live site
  sat on the previous commit and a shipped UI change was simply invisible.
  Confirm with Vercel MCP `list_deployments`: every commit should appear
  TWICE, once `target: null` (preview) and once `target: "production"`. One
  entry alone means it did not ship. Re-trigger with an empty commit pushed to
  `main` — Vercel needs a new SHA, so re-pushing the same one does nothing.
  **The app now answers this itself**: `lib/build.js` reads Vercel's system env
  vars and `Admin → Health` prints the RUNNING commit, so the check is
  `git rev-parse origin/main` against a number on the page rather than a
  dashboard reading. It is also the first check and rides the payload as
  `build`. Nothing is fabricated — off Vercel it reads `unknown` (never amber:
  that is every sandbox's normal state, and a permanently-amber check takes the
  twelve beside it down with it), and a PREVIEW deployment WARNS, because
  reading Health on a preview URL makes every other number describe the wrong
  deployment. Deploy TIME is deliberately absent rather than approximated —
  Vercel exposes none at runtime, and `instanceStartedAt` is the lambda's cold
  start, labelled as such. Pinned by `verify-build-identity` + `render-health-tab`.
- **Other sessions push here too.** Fetch before pushing and REBASE onto
  `origin/main` rather than forcing over it, then re-run the suite: the merged
  tree is what ships, and neither half was tested against the other. "Require
  branches to be up to date" in the ruleset is the automated form of this.
- Does NOT ship with a deploy: env vars (Vercel dashboard only), DB schema
  (manual SQL, ask first), OG images (committed PNGs; regenerate by script).

## Drift (repo ↔ live, verified 2026-08-02)

| Where | Fact |
|---|---|
| `schema.sql` | **RESOLVED 7 Aug.** Was missing `pr_users`, `pr_audit`, `pr_alerts`, `pr_usage`, `pr_subscribers.whatsapp` and `pr_users.reset_requested_at` — a file that looked authoritative and could not rebuild a working database. Reconstructed from the LIVE catalogue (read-only `information_schema`/`pg_indexes`/`pg_constraint`), so it matches production exactly: note `pr_users.id`/`pr_audit.id` are IDENTITY columns, not bigserial, and `pr_users.role` carries a CHECK. All 11 `pr_*` tables now present, all RLS-on/no-policies. Pinned by `verify-schema-baseline`, which derives what must exist from what `lib/db.js` actually queries rather than a hand-kept list — so a new column used in code fails the commit that adds it |
| Vercel env | `RADAR_TO` unset → the **team/admin** copy of the daily brief doesn't go out; the brief itself does, via the subscriber path, which never reads `RADAR_TO` (6 active subscribers, 5 Aug). Adding recipients is better done in Admin → Subscribers than here — the var needs a dashboard edit **and** a redeploy. Set **`OPS_ALERT_TO`** too, or the daily health push records its alert and reaches nobody (it falls back to `RADAR_TO`) |
| `pr_state.daily_bulletin_sent` | RESOLVED — advancing daily since the 3 Aug run; read **05 Aug 05:00** on 5 Aug (live-verified). The ten-day freeze was the marker-stamping bug fixed 2 Aug (see the two-recipient-lists Gotcha). **A stale marker is not a missed send** — check Resend, not `pr_state` |
| `pr_items` | **Cause found and fixed 2 Aug** — the bursts (100 parked in the 7 days to 2 Aug) were the classifier omitting items from an otherwise-valid reply, which parsed cleanly and so never retried; see the omission Gotcha. **73** burst-era rows still sit parked in the rolling 7d window (5 Aug; 0 parked in the last 24h — the fix holds) and keep the Health check red until they age out ~6 Aug or are cleared with Admin → Tools → "Re-classify parked stories" |
| Meta | A **new WABA "PR Radar"** was created 3 Aug alongside the old *Test WhatsApp Business Account*; account status Approved, business verification still Unverified. **Templates do not transfer between accounts**, so `pr_urgent` must exist and be APPROVED on whichever WABA `WHATSAPP_PHONE_ID` belongs to. `#132001` cannot distinguish its three causes (unapproved / wrong language code / wrong account) — use **Admin → Tools → "Check account & template"** (`?view=whatsapp-check`), which asks Meta from production and names the fix. Set `WHATSAPP_WABA_ID` if the account can't be resolved from the phone number. The template body carries **TWO variables** — `{{1}}` the story, `{{2}}` the action — because a variable's VALUE cannot contain a newline, so the paragraph break has to live in the template. The send shape must match how they are declared: `WHATSAPP_TEMPLATE_VAR` is a CSV of the variable names in order (default `1,2` = positional; names like `story,action` send `parameter_name`). A mismatch fails as `#132001`, exactly like a missing template |
| `api/radar.js` comments | **RESOLVED 7 Aug.** Two comments justified the daily-send guard with "the 04:10 GitHub Actions backup". No such workflow has ever existed here — the guard is right, the reason given for it was fiction, and a reader chasing that cron would have found nothing. Both rewritten around the real second callers (the 15-min poll, a manual admin run). The repo now HAS a workflow, `.github/workflows/ci.yml`, and it runs tests only — it deploys nothing and calls no endpoint |

## Gotchas (each cost real debugging time)

- **The daily brief has TWO independent recipient lists**, and only one of them
  is in the repo's reach. `RADAR_TO` (Vercel env, CSV of `Name <email>`) gets the
  team copy — "Hi *Name*," header, `, N negative` subject tail, the ⚠ unclassified
  footer, `RADAR_BCC`. `pr_subscribers` (Admin → Subscribers) gets the same
  `renderBulletin` output with a per-subscriber category filter and a
  `, N needing attention` subject. Same stories, same feed-health footer; the
  `variant: 'admin'` argument is vestigial — `renderBulletin` doesn't destructure
  it. Subscribers are the better list: self-serve, filterable, no redeploy.
  `daily_bulletin_sent` is stamped when the brief reached **anyone** — gating it
  on the `RADAR_TO` send alone left the marker frozen for ten days while mail
  went out daily, so the `!dailyAlreadySent` guard in front of the subscriber
  loop was permanently open and any manual `/api/radar` hit re-mailed every
  subscriber. Pinned by `verify-daily-once`. **A stale marker is not a missed
  send** — check Resend, not `pr_state`.
- **One score, three names: `severity` (prompt) = `importance` (column) =
  **Impact** (every surface).** It was labelled "Reach" until 1 Aug, which read
  as audience size — but the classifier weighs how *directly* a story hits
  Vodafone as well as how far it travelled, so a small outlet landing squarely
  on us outranks a big one that barely mentions us. `guide.html` said "more dots
  = more people likely see it": half the definition, and the wrong half. The
  guide now spells out both factors, all five rungs and the never-below-3 floor
  for Vodafone-negatives. Renaming touched the board, both emails and the guide
  together — `render-lanes` pins the board label + tooltip, `render-email-design`
  the email half, `render-guide` the explanation. `lib/report.js` prints a bare
  `N/5` and carries no label. **The BOARD and the BRIEF have different floors** —
  everything `is_relevant` reaches the board, Impact 1 included (5 such cards
  live 2 Aug); the daily digest filters at `importance >= 2`. The guide claimed
  "the board starts at Impact 2" and the prompt justified its scoring floor with
  "so it still reaches the board" — both false, and both sent a reader hunting a
  filter bug for cards behaving as designed. Pinned by `render-guide`.
  **Only 5 alerts in real time**; a 4 waits for the
  05:00 brief.
- **The board's Sort chip re-orders; it never filters.** `◉ Impact` is the
  original order (lane → Impact → spread → recency) and is what LOADS. It is
  deliberately NOT persisted the way `pr_win` is: a Newest sort set once and
  forgotten quietly pushes an Impact 5 below a trickle of fresh trivia, and on a
  board whose job is surfacing the worst thing first the safe order has to be
  the one that comes back after a reload. `↓ Newest` DROPS the three lane
  sections for one flat chronological run (user decision, 6 Aug) — sorting by
  time *inside* the lanes still buries the freshest story under two headings,
  which is the only question the control exists to answer. Impact stays the
  tie-break, so equally fresh cards are not left in API order. Cards keep their
  lane TINT, so a needs-response story still reads red in the stream, and a
  single `↓ Newest first` header opens the list — without it, absent lanes read
  as a rendering bug rather than the order you picked. The status line names the
  order only when it is not the default. Pinned by `render-board-sort`.
- **Instant alerts fire on `isInstantAlert` (`lib/email.js`), not on Impact 5.**
  Impact 4-5 **or** any negative story about one of the four tracked operators
  (`TRACKED_OPERATORS`) at any Impact — a bad story shouldn't wait out the 05:00
  brief because its pickup was small, and a rival's trouble is intelligence the
  team wants while it is still developing (**widened 5 Aug, user decision**;
  rivals were previously excluded on the theory that "every rival outage would
  page the team" — live data disproved it: **two** competitor negatives below
  Impact 4 in 30 days). `market` and unbranded items still do NOT alert on
  sentiment alone — neither names an operator to act on. Because rivals now
  alert, `urgentTier().why` NAMES the brand ("a negative Orange story"), so a
  reader can tell a competitor's problem from ours in the header.
  **Alerts are evaluated at INGEST ONLY** — nothing ever re-runs the rule over
  stored cards. So a card CORRECTED into the qualifying band after the fact
  (5 Aug: a court story branded e& off an unnamed «شركة اتصالات», corrected to
  Vodafone) has already silently missed its alert. The board's admin-only **🔔**
  (`?resource=send-alert`) is the only path that fires it late: same rule, same
  `renderUrgent`, same recipients, same side channels, audited as
  `alert.manual`. It is gated on the LIVE rule (not the admin's judgement),
  refuses a hidden card, and answers 409 on a second click — one `pr_state`
  marker per card, `force:true` to override for a genuine re-alert. Pinned by
  `verify-send-alert-tool`. `urgentTier()` sits beside the rule and
  drives the badge, the "why it fired" line **and** the subject in `api/radar.js`
  — only Impact 5 says URGENT, everything else says ALERT, because labelling all
  of it URGENT is how an alert channel earns being ignored. Both live in
  `lib/email.js` so the trigger and the wording cannot drift. ~1 alert / 5 days
  on the history to 1 Aug. Pinned by `verify-urgent-recipients` (including the
  must-NOT-fire cases). Changing the rule means changing the guide's two urgent
  blurbs and the alert footer in the same commit.
- **Every send is ONE MESSAGE PER RECIPIENT** — `sendBulletin` fans out inside
  itself, so no caller can put a distribution list in a single `To`. It used
  to POST once with all N addresses, which showed every reader the rest of the
  list (a disclosure on a corporate list, not a formatting detail) and let one
  malformed or suppressed address make Resend reject the batch — silencing a
  crisis alert for the whole team. The urgent path, surge, weekly report and
  geo all passed a CSV; the daily brief already looped. `sendOpsAlert` fans out
  the same way but records its history ONCE, not per recipient. Reaching nobody
  still THROWS (that is the dead-channel signal callers scream on); a partial
  failure is returned as `{sent, failed}` and logged per address, never thrown.
  The return spreads the first Resend response so `.id` still works. Pinned by
  `send-guard` + `verify-urgent-recipients` + `verify-health-checks`.
- **The WhatsApp crisis list lives in Admin → Subscribers**, not in an env var.
  `WHATSAPP_TO` needed a Vercel edit AND a redeploy, so in practice it never
  changed: on 3 Aug it held ONE number while the daily brief reached five people
  — the channel added for speed reached the fewest readers, and no screen said
  so. `resolveWhatsappRecipients()` returns the UNION of `whatsappSubscribers()`
  (active AND `whatsapp not null`) and `WHATSAPP_TO`, deduped — a number in both
  is messaged once. It briefly had the env var OVERRIDE the list, which silently
  ignored four numbers typed into Admin while the panel still read "1 recipient":
  you could add four people and page none of them. Both are real recipients, so
  both are used. Credentials present but nobody to send to now
  SCREAMS and returns `skipped:'no recipients'` — it used to look identical to a
  clean send. `whatsappConfigured()` deliberately no longer requires recipients,
  or a list managed entirely in Admin would read "unconfigured". Numbers are
  shown masked (country code + last 4) on the subscriber row and in the check.
  **Admin → Tools → "Send test alert" is scoped to `WHATSAPP_TO` ONLY**
  (`sendWhatsAppUrgent(item, {to})`), so a delivery check never pages the team —
  the same rule as the email test going to the signed-in admin. With the channel
  configured but `WHATSAPP_TO` empty it refuses and names the variable; with the
  channel not configured at all it stays the existing safe no-op, because
  pointing at `WHATSAPP_TO` when there is no token is the wrong problem.
  **A failed send now names its reason.** `pr_urgent` was APPROVED on 4 Aug and
  every send still failed **`#131037 — the sender's display name needs approval`**:
  the template clearing review is only half of it, the NUMBER's display name is
  reviewed separately and blocks all sending until it passes. The panel said
  "1 failed (check logs)", which is a dead end for the one person who can fix
  it, so `sendOne` returns the API's code + message and the panel prints it
  (deduped — five recipients blocked by one account-level problem is one fact).
  The number's own review state is `name_status` on the phone node, and it has
  **TWO passing values** — `APPROVED` *and* `AVAILABLE_WITHOUT_REVIEW` (the
  business is exempt from review). Treating everything ≠ APPROVED as a blocker
  told the operator to wait on a review Meta had already cleared. Live reading
  is `AVAILABLE_WITHOUT_REVIEW` + `CLOUD_API`, so the display name is NOT what
  is failing. The sender is **+1 555-428-5748** — the fictional +1 555 range
  Meta auto-provisions as a TEST number, which only reaches recipients
  pre-registered against it, and that is the remaining explanation for #131037
  with every checkable field green. `whatsapp-check` now says so itself.
  Registering a real business number is the only fix. Pinned by
  `render-whatsapp` + `verify-whatsapp-check`.
  **Readiness is a FIVE-RUNG LADDER, not a boolean** (`whatsappReadiness`):
  credentials → a real sender → an approved template → a cleared display name →
  recipients. `whatsappConfigured()` answers rung ONE, and Admin read it as the
  whole question — which is how "template APPROVED, display name cleared,
  credentials set" read as healthy while every send failed on the +1 555 test
  sender. Rungs 3 and 4 can only be answered by ASKING Meta, so without a probe
  they report **unverified**, never fine. The check is never CRIT: WhatsApp is
  the side channel, email is the one that must work, and a red page over a
  secondary channel blocked for a week trains its reader to ignore red. Pinned
  by `verify-readiness-checks`.
  The WhatsApp message LEADS with the same `urgentTier()` label as the email
  subject (URGENT / ALERT) — the template's header line is static text and
  cannot vary per message, so the tier has to live inside `{{1}}`.
  Pinned by `render-whatsapp` + `render-guide`.
- **`sendBulletin` with no `to` silently means `RADAR_TO`** — and `RADAR_TO` is
  unset in production, so for every severity-5 story the urgent path threw "no
  recipients", caught it, logged it, and reached nobody. Latent since launch:
  `pr_items` has never held an importance-5 row, so the first real crisis would
  have been the first test of a dead channel (WhatsApp is template-blocked and
  the webhook unconfigured, so it was all three channels). Urgent now falls back
  to `activeSubscribers()`, **ignoring their category filters** — severity 5 is
  a live threat to Vodafone Egypt, so a surprise email beats a missed crisis
  (the digest still filters). `RADAR_TO` still wins when set, leaving room for a
  curated crisis list. Pinned by `verify-urgent-recipients`. General rule: never
  let a send default its recipients — pass them, or prove the default is
  populated.
- **An omission is not a verdict** (`classifyChunk`, `lib/classify.js`). Verdicts
  map onto the batch by each object's `i`, and a reply that simply leaves items
  out parses cleanly — so the hard-failure split never fired and every skipped
  item was stored `category:'unclassified'`, hidden from board and brief. One
  batch of 25 off-topic Reuters wire stories came back with no verdicts at all
  (1 Aug) and raised a CRITICAL reading "API error or spend cap" — neither had
  happened; the model had declined to answer for obvious junk. Now: gaps are
  re-asked for **just the missing items**, a wholly empty reply is **split**
  rather than resent identically (a repeat prompt repeats the answer), and
  `MAX_REASK` (2) bounds it — splitting is NOT bounded by it and terminates at
  one item. The prompt now demands exactly one object per input. Deliberately
  never recast an omission as `is_relevant:false`: that silently drops a real
  story the model merely forgot. Pinned by `verify-classify-gaps`.
  Rows already parked are cleared by **Admin → Tools → "Re-classify parked
  stories"** (`?resource=reclassify-parked`) — same predicate as
  `parkedItemCount`, so the Health check and the tool always agree. It PATCHes
  verdicts onto the existing rows by id (never hash/url/seen_at, so cards keep
  their identity and coverage) and reports `kept` separately, because a run that
  rescues a real story must not read like one that swept up wire noise. Pinned by
  `verify-reclassify-tool`.
- **An allowlist row is only HALF an account.** Adding someone in Admin → Users
  used to write `pr_users` and stop, which left them stuck: nothing told them
  they could now "Create account" on the login screen, and an ADMIN could not
  even do that (`/api/auth` signup refuses `role=admin`, deliberately). Adding a
  user now provisions the person — `provisionUser` (`lib/auth.js`) writes the
  allowlist row AND a starter password, `?resource=users` optionally adds them to
  `pr_subscribers`, and `renderWelcome` mails them their own address + password.
  Four rules the code holds and a change must keep:
  **(1) Provision with `adminCreateUser`, NEVER `adminSetPassword`** — that one
  falls back to a PUT when the account exists, so using it here would silently
  reset the password of anyone re-added (reactivated, role fixed). Create-only
  means the SERVER decides: 422 ⇒ `credentials:'existing'`, with no read-then-
  write window where a failed lookup reads as "no account yet".
  **(2) The welcome email is sent ONLY when we created the password.** Mailing a
  password to someone who already has their own reads as "your password changed"
  and sends them to a login that fails.
  **(3) The subscriber add must ASK FIRST** (`getSubscriberByEmail`) — see that
  Gotcha; an active row is left completely alone, a paused one gets a targeted
  `active:true` PATCH.
  **(4) The temporary password is RANDOM and derived from nothing.**
  `generateTempPassword()` (`lib/auth.js`) — `crypto.randomBytes`, 30 characters
  over a 32-symbol unambiguous alphabet in six hyphenated groups = **150 bits**.
  It used to be a CONVENTION, `firstName + 123` (`Tamer Basha` → `tamer123`),
  chosen so an admin could say it over the phone; the price was that a corporate
  mailing list plus a public sign-in page made every colleague's account
  guessable until they got round to changing it. Nothing in the value may come
  from the name, email, role, id or the time of issue — a timestamped seed is
  guessable by anyone who knows roughly when the account was made. The
  readability lives in the FORMAT now (recovery-code shape), not the content.
  The alphabet is 32 symbols so masking 5 bits per byte is UNIFORM; the admin
  reset generator in `public/admin.html` was `v % 54` over 12 characters (~69
  bits, and biased) and now matches the server exactly. Pinned by
  `verify-user-provision` (25 provisions of the same person ⇒ 25 different
  passwords; no `mona`/`said`/`admin`/`123` substring) + `render-adminui` (the
  browser generator's shape, uniqueness and full-alphabet reach).
  Each step is reported separately (`credentials` / `subscriber` / `emailed` /
  `bccd`) because a provisioned account whose email bounced needs a human to pass
  the password on, and that must not read like a clean run. The admin's own BCC
  copy is the only lasting record (the panel dies with the page), and it rides
  `who.email` — so it does NOT exist for a service-token call or when an admin
  adds themselves; `bccd` reports which, because the panel claimed it either way.
  **A test authenticating as `CRON_SECRET` cannot see any of that** — a service
  principal has no email, so the BCC and support-address branches are dead under
  it, which is exactly how the BCC shipped untested. Both defaults are ON in
  the UI — a checkbox the admin has to hunt for is one that stays unticked.
  Pinned by `verify-user-provision` + `render-user-create`.
- **"Forgot password?" has no reset LINK, on purpose — it pages a human.** An
  emailed token means expiry, single use and Referer leakage to get right, for a
  team of this size; PR Radar instead flags `pr_users.reset_requested_at` and the
  request reaches an admin TWO ways at once — `sendOpsAlert` now, and a row in
  Admin → Requests that stays until it is handled. Four things a change must
  keep: **(1) the answer to the browser is byte-identical** for a real account
  and an unknown address, or the sign-in screen becomes a directory of who has
  access (the audit records `known:true/false`; the reader never learns it).
  **(2) Only a real, ACTIVE account mails anyone** — otherwise the form is a way
  to spray the ops inbox with arbitrary addresses, and a deliberately blocked
  user must not page anybody. **(3) The alert names `ADMIN_EMAILS`** when
  `OPS_ALERT_TO`/`RADAR_TO` are unset (both are, in production) — that is what
  `sendOpsAlert`'s new `opts.to` is for; recording an alert that reaches nobody
  is how a locked-out colleague waits for a reply that was never sent.
  **(4) Setting a password ANSWERS the request** from all three paths (admin
  reset, self-service change, first signup), so the queue empties itself rather
  than needing a "mark done" click; Dismiss is only for a request you decide not
  to action, and says out loud that the password is unchanged.
  The column is now APPLIED in production (live-verified 7 Aug), but the
  degradation stays and stays TESTED: `listUsers` asks for it and falls back
  without it (a select naming a missing column 400s the WHOLE Users tab), and
  every helper returns false/[]/null on failure — so a rebuilt or rolled-back
  database is a feature that is absent, not a 500 on the sign-in screen. Pinned by
  `verify-password-reset` + `render-reset-ui`.
- **A prompt cache is only worth ASKING for when a read can follow the write.**
  The classifier's ~5k-token system block is identical every call, so caching it
  looks obviously right — but a WRITE bills above normal input and only pays back
  on a later READ, and the ephemeral cache expires in ~5 minutes. Live 2 Aug,
  first day `pr_usage` recorded: 26 classify runs, **every one a single batch**,
  15+ min apart on the urgent poll — 128,364 write tokens, **0** reads. Every
  call paid the premium and none collected, and Health called it "reuse has
  collapsed" as though something had broken. `classify()` now asks for the cache
  ONLY when `chunks.length > 1`, and then awaits the FIRST chunk before fanning
  out the rest — firing all batches at once races the write and they all miss.
  Pinned by `verify-prompt-cache`. General rule: a cache that is never read is
  strictly worse than no cache.
- **A flex row silently starves its ONE flexible child.** The board header had
  `.ttl{flex:1}` among `flex:none` siblings, so it absorbed every shortfall —
  and since `.wrap` caps at 840px the row is over-subscribed at EVERY viewport,
  not just phones: "PR Radar" rendered `PR Ra…` on desktop and collapsed to a
  **1px** `P…` on a 390px phone. The document never overflowed, so the existing
  `scrollWidth > clientWidth` guards saw nothing — the damage was entirely
  inside the row. Same week, the admin tab row (7 tabs) had the opposite fault:
  no `overflow-x` of its own, so it widened the whole document and the page
  panned sideways. Rules: give the row `overflow-x:auto` or give the least
  important child `display:none`, never let identity text be the flexible one,
  and test at 390px — `render-header-mobile` asserts nothing renders narrower
  than its own content. Pinned by `render-header-mobile` + `render-adminui`.
  **It recurred in the admin list rows** (6 Aug): a `.row` is identity + an
  action cluster, `.acts` is `flex:none`, so `.who` again absorbed everything —
  the Users row's four controls need 303px of the 328px a 390px phone leaves
  inside the card, so the email got **15px** of the 228px it wanted (`tame…`,
  the role pill clipped away entirely, the meta line 144px tall at one word per
  line) while the document still never overflowed. The fix for a row that must
  keep BOTH halves is a flex **basis**, not `flex:1`: `.who{flex:1 1 180px}` +
  `flex-wrap` on the row makes it BREAK instead of starve — actions wrap below
  and right-align, and a row whose actions do fit (subscribers' three icons) is
  untouched. Width-driven, so there is no breakpoint to keep in sync. `.acts`
  needs `max-width:100%` too or `flex:none` refuses to shrink and widens the
  document below ~330px, and identity text WRAPS (`overflow-wrap:anywhere`)
  rather than ellipsising — hiding half an address, or the role, is worse than
  two lines. Pinned by `render-admin-rows`.
  **And in the board card's `.foot`** (6 Aug), which is the third shape of the
  same fault: a row of controls with nowhere to give. A viewer sees 3 (Copy, 📸,
  Open) and fits; an ADMIN sees 8 — 359px of controls in the 322px a 390px phone
  leaves inside a card — so with no wrap every one of them shrank: both labels
  folded into FOUR lines inside 59px/69px boxes, the icon buttons dropped from
  their 38px touch target to 30px, and the row overflowed anyway, panning the
  whole page (3px at 390, 73px at 320). So the board bug was admin-only, which
  is why five months of viewer use never surfaced it. Fixed with
  `flex-wrap` on `.foot` + `flex:none` on `.btn`/`.fb` so controls keep their
  designed size and the row breaks; `.btn.open`'s `margin-left:auto` still
  right-anchors it on whichever line it lands on. Wrap, not `overflow-x`, for a
  row of ACTIONS: one a reader must scroll sideways to find may as well not
  exist (the opposite call to the tab row, where the tabs are navigation and
  scrolling is the known idiom). Pinned by `render-card-foot`.
  **Worst instance: the Trends leaderboards** (6 Aug). `.lrow` is name + spark +
  bar + value + chevron, and everything except the name is unshrinkable
  (`.val` is flex:none nowrap text ~192px — "38 · 24% negative · 9 Vod-neg";
  `.spark` a fixed 72px), so `.nm` took the whole shortfall: **0px at 360, 17px
  at 390, 57px at 430** against the 168–200px it needed. Outlet intelligence
  read `ك.. / D.. / O..`, Journalist intelligence `م.. / J..`, the journalist's
  outlets sub-line vanished and the sentiment bar was squeezed to **0px** — the
  "which outlet is talking about us" question the cards exist to answer was
  unanswerable on every phone. Now the row STACKS below 560px (`flex-wrap` +
  `.nm{flex:1 1 100%}` wrapping, bar+value beneath, `.spark{display:none}`) —
  extending to every row what this file already did for `.lrow.narr`, which is
  why narrative rows alone had always been readable. The Trends header carried
  the board's original `.ttl{flex:1}` fault too: 342px of content at 320px,
  panning the page 22px and truncating "Trends" itself; the clock now hides
  below 560px, the same call `index.html` makes at the same width. Pinned by
  `render-leaderboard-mobile`. **Reports (`reports.html`) was measured over the
  same widths and is clean** — its `.row` of two `flex:1` action buttons shares
  the shortfall evenly and only grows taller below 360px; don't "fix" it.
  **And the wrap fixed the FIT, not the LOAD** (7 Aug): eight equally-weighted
  controls still asked a reader to scan all eight to find one. The four
  lower-frequency admin actions (Pin, Hide, Useful, Not useful) moved into a
  **••• More** menu, leaving five primary — Copy · 📸 · 🔔 · ••• · Open source.
  📸 stays primary because a VIEWER uses it (their card is unchanged at three
  controls — this must cost the majority of readers nothing); 🔔 stays because a
  missed alert is the only time-critical thing on the card. The menu is
  **anchored to the footer's right edge, not to the ••• button** — button-anchored
  it overflows the card's left edge when ••• wraps to the start of a row. It
  opens focused on its first item, walks with arrows, closes on Escape
  (returning focus to the button — an Escape that strands you at the top of the
  document is a menu you cannot leave), on an outside click, and on choosing an
  item; `aria-expanded` moves WITH the panel; and the item LABEL flips with the
  state (`Pin for the team` ↔ `Unpin`), because an item reading "Pin" while
  already pinned is a lie. The whole menu is admin-gated by
  `body:not([data-role="admin"])` — stricter than the old
  `[data-role="viewer"]` rule, which showed those four for the moment before
  `loadMe()` resolved. Pinned by `render-card-foot`.
  Fixed alongside it: `vote()` cleared `aria-pressed` on EVERY `.fb` in the
  card, so voting silently un-pressed the pin and hide buttons — the stored
  value was untouched, so it came back on the next render and read as a
  rendering glitch.
  **`render-final-sweep` is the net under all of it**: every page × 320/360/390/
  430/768/1280 × viewer AND admin, asserting no document pan, nothing rendered
  narrower than its own content, no non-inline control under a usable tap
  target, and no page error. It found three real ones on its first run — the
  board's `?` guide link measured **9px wide** (`display:grid` with
  `place-items:center` sizes to the glyph unless the box is told otherwise),
  Trends' chart legend entries were 16px tall despite doubling as filter links,
  and the Reports page's two `.back` links — the only way OFF that page — were
  14px. Two measurement rules it had to learn: **`scrollWidth` is meaningless on
  an SVG node** (own coordinate system — chart legibility is
  `render-leaderboard-mobile`'s job), and an **`display:inline` link is
  typography**, not a tap target.
  General rule for this whole family: a flex row of controls needs an explicit
  give — wrap, scroll, or a hidden child — and `flex:none` on anything whose
  size is part of its usability (touch targets, identity text). A row whose
  siblings are ALL unshrinkable has no give at all: measure it at 320/360/390
  rather than trusting that the flexible child will cope.
  **And the "hidden child" escape has its own trap** (6 Aug): the board header
  paid for its room with `.account .who,.account .acctlink.pw{display:none}`
  below 560px — which deleted the ONLY route to `/account`, so on a phone nobody
  could change their password, while the welcome email says "open Password in the
  top bar" and two lines later suggests Add to Home Screen. Nothing failed and no
  test could see it: the control was simply absent. Hiding a child is only safe
  when its FUNCTION is reachable another way; a route with one entry point is not
  a candidate. Identity + change-password + sign-out now live in an **account
  menu** (`Account ▾`, `renderAccount`/`wireAccountMenu` in `public/index.html`)
  — one button that never needs to shed anything, so the breakpoint where the
  feature disappeared no longer exists. The guide, the admin help text and
  `renderWelcome` all name `Account → Change password`; change the menu and all
  four move together. `stats.html`/`reports.html` deliberately have no menu —
  they carry a `.back` to the board, and PR Radar pages are self-contained, so a
  third copy would be three places to drift. Pinned by `render-account-menu`
  (320/390/560/900px, viewer AND admin) + `render-authui`.
- **The session lives in ONE file** (`public/assets/session.js`). "Read
  `pr_session`, refresh against GoTrue, attach a Bearer header, retry once on
  401" was pasted into SIX pages character-for-character, plus a seventh partial
  copy in `login.html` (which CREATES the session the others read). Six places
  for a security-relevant fix to land, and the failure is silent — five pages
  get it, the sixth keeps the bug until someone opens it. Rules the module
  holds: the token travels in the `Authorization` header and nowhere else,
  `saveSession` is the single writer of `pr_session`, a 401 buys exactly ONE
  refresh (unbounded would loop on a dead session), and nothing there logs.
  **Residual security debt, recorded not hidden**: access + refresh tokens are
  in localStorage, so any successful XSS reads them. The real fix is Secure
  HttpOnly SameSite cookies, which needs a server-side session exchange (GoTrue
  hands tokens to the BROWSER), CSRF on every mutating endpoint, and a rewritten
  refresh path — a half-migration would be worse than either end state. This
  extraction is the preparation: one implementation to change instead of seven.
  It is also what makes dropping `'unsafe-inline'` from the CSP reachable.
  A page must not redefine any of it — `var` in the module and `let` in a page
  is a hard SyntaxError that kills the whole inline block. Browser test servers
  must serve `.js` as `text/javascript`; a shared module arriving as `text/html`
  leaves the page with no `afetch` at all and it still renders. Pinned by
  `render-session-shared`.
- **An icon is not a name, and `title` is not an accessible one.** The card
  footer offered 📸 🔔 📌 🙈 ▲ ▼ and the admin rows ✎ ✕ with the meaning only in
  a tooltip — which a screen reader does not reliably announce and a touch user
  can never see, so six of an admin's eight card controls were unlabelled. Rule:
  **a control whose visible text contains no letters (Latin or Arabic) needs an
  `aria-label`**, and a toggle needs `aria-pressed` beside it so it announces
  its STATE as well as its name. Every region that reports the result of an
  action (`.formmsg`, `#msg`, `#uOut`, the board's `#status`) is
  `role="status" aria-live="polite"` — **polite deliberately**: each message
  follows a submit the reader is already waiting on, and assertive would
  interrupt mid-sentence, which is how announcements get turned off. Nothing in
  this app is urgent enough for `role="alert"`. Pinned by `render-a11y`, which
  scans EVERY page (so a new one cannot skip it), rejects a label under four
  characters or one that says "button", and checks the computed names, the
  post-click state and keyboard reachability in a real browser.
- **Warm lambdas persist module state.** Any counter/cache at module scope
  survives between invocations — the AI byline budget must be reset per run
  (`resetAuthorAiBudget()`); think before adding module-level state.
- **This sandbox cannot reach production or news sites** (egress proxy 403s
  arbitrary hosts) and has no production secrets. Verify via Supabase/Vercel/
  Resend MCPs, or ship an admin diagnostic (pattern: Tools → "Verify
  verdicts") and let production prove it.
- **The browser security posture lives in `vercel.json` and nowhere else** —
  no framework, no middleware, so it is invisible in code review and silently
  deletable. **CSP**: `default-src 'self'`, `base-uri 'none'` (a `<base>`
  silently repoints every relative URL including `/api/*`), `object-src 'none'`,
  `frame-ancestors 'none'`, `frame-src 'none'`, `form-action 'self'` (the
  sign-in form posts passwords), `img-src 'self' data: blob:`, `connect-src
  'self' https://*.supabase.co`. Two allowances are load-bearing and easy to
  break by "tightening": **`blob:` in img-src** — the card snapshot previews a
  canvas as `<img src="blob:…">`, and without it the sheet shows a broken image
  with nothing in the console; **`https://*.supabase.co` in connect-src** —
  every page's `refreshSession()` POSTs to `${supabaseUrl}/auth/v1/token`, so
  dropping it signs every user out the moment their access token expires. The
  wildcard is the PROVIDER, never the project ref (tracked-file rule).
  **`script-src`/`style-src` keep `'unsafe-inline'` ON PURPOSE, and that is the
  remaining weakness**: pages are self-contained by design, the board and admin
  carry ~55 inline `onclick` attributes, and the PDF export opens a `blob:`
  document that INHERITS this policy and prints from an inline handler.
  Removing it means de-inlining all of that FIRST — declaring it before then
  ships a blank board. `'unsafe-eval'` is refused outright.
  **`upgrade-insecure-requests` is deliberately absent**: it rewrites outgoing
  navigations, and the http-only Egyptian outlet links `safe-url.js` keeps on
  purpose would break. **HSTS** is a year + includeSubDomains, **without
  `preload`** — preload is effectively irreversible and binds the registrable
  domain, which is the owner's call. Plus COOP `same-origin`.
  Pinned two ways, and both are needed: `verify-security-headers` asserts every
  directive AND that the pages fit it (no remote subresource, no `<base>`, no
  `eval`), and `render-csp` SERVES the real header and loads all eight pages in
  a browser, failing on any violation — a directive one token too narrow
  produces a page that renders and then quietly does nothing.
- **An `href` is a destination, and `esc()` does not vet one** (`lib/safe-url.js`).
  Article URLs are third-party all the way down — a feed supplies them,
  `resolveUrl` rewrites them from whatever Google News returns, they are stored,
  and they reach the board's `href`, five email templates, a webhook, a Word
  export and **`/api/go`'s `Location:` header on a PUBLIC endpoint**. Nothing
  checked the SCHEME. `esc()` was everywhere and is the wrong tool: `javascript:`
  contains no character HTML-escaping touches, and a `Location` header is not
  escaped at all. `safeExternalUrl` / `firstSafeUrl` are the one rule — a CLOSED
  allowlist of `https:`/`http:` (http kept deliberately: Egyptian outlets still
  serve it, and refusing would blank real cards to buy nothing), plus refusals
  for control characters (`java\tscript:`), protocol-relative `//host`,
  hostless URLs, over-length values, and **embedded credentials**
  (`https://vodafone.com.eg@evil.example/` reads as Vodafone and goes to
  evil.example). Applied at ingest (`fetchFeed` drops an item with no usable
  link), after `resolveUrl`, in `setResolvedUrl`, in every renderer, and in
  `/api/go` — where the cached `resolved_url` is **re-validated on every read**,
  never trusted because it was validated once on write, and a row with no usable
  link answers **502** rather than redirecting somewhere unvetted. `public/index.html`
  carries a browser MIRROR (`safeUrl`) because the board builds its own hrefs;
  `render-safe-url` asserts both sides against the SAME 29-case table, so the
  two cannot drift the way the server and the board already had. It also fails
  any `target="_blank"` without `rel="noopener noreferrer"`.
- **Feed text is DATA, and all five LLM passes are told so** (`lib/prompt-safety.js`).
  Headlines, excerpts, outlet names, scraped article pages and another AI's
  answer about Vodafone all arrive from outside and go straight into a prompt.
  The structural position was already good and must stay that way: **no pass
  defines a tool, none takes an action, and every output is validated** (verdicts
  map onto a fixed key set; narrative ids are checked against the ids that went
  in). So the realistic harm is a WRONG VERDICT — a hostile story marking itself
  irrelevant so it never reaches the board, or the other 24 items in its batch
  mis-screened. Two defences: the shared `UNTRUSTED_DATA_RULES` block in every
  system prompt, and — the one that actually holds — source text FENCED in
  `<source_text>` with each field `neutralize()`d so it cannot CLOSE the fence.
  Same lesson as the bylines: an instruction is necessary and never sufficient;
  the deterministic guard is what works. `neutralize` is deliberately narrow —
  it rewrites only that tag pair and strips control characters, because feed
  text legitimately carries `<b>`, quotes and «guillemets» and mangling those
  would corrupt the headline the board displays. The attempt is **kept
  readable**: it is a fact about the item, so hiding it would make a hostile
  source invisible rather than harmless. The five passes are `classify`,
  `dedupe-semantic`, `narratives`, `author` and **`geo`** — the last was found
  by the test's source scan, not by reading, which is why the scan fails any new
  `api.anthropic.com` call site that skips the module. Pinned by
  `verify-prompt-injection`.
- **Feed XML is hostile input, and there is ONE parser** (`lib/xml.js`).
  `api/radar.js` and `api/admin.js` each built their own `XMLParser` with
  duplicated options, so hardening one left the other reading third-party XML
  under the old rules; `verify-xml-hardening` now fails any file outside
  `lib/xml.js` that imports `fast-xml-parser`. Three guards, each for a real
  way a feed can hurt a 60s function: **size** — `readCapped` streams and
  cancels past 4 MB, because `await res.text()` buffers whatever the server
  sends and 30 feeds are fetched in parallel, so one unbounded body is an OOM
  for the whole run; **entity declarations** — a DOCTYPE containing `<!ENTITY`
  is refused unparsed (billion-laughs / XXE), scanning ONLY the doctype so an
  article about XML with `<!ENTITY` in its CDATA is not killed; **one option
  set**. A refusal throws, and `fetchFeed`'s existing catch records it as a
  failed feed exactly like an http 500 — a hostile feed goes dark, not the run.
  `processEntities` stays ON deliberately: named/numeric entities are what real
  feeds carry, and `decodeEntities` in `api/radar.js` only ever handled Google
  News' *second* layer of encoding on top.
- **Never add a feed URL unprobed.** A 404 fails silently and the radar looks
  calm while blind. Candidates live in `lib/feed-candidates.js`; Admin → Tools
  → "Probe feeds" verifies them FROM PRODUCTION (the sandbox has no egress to
  news hosts), then a verified URL moves into `DIRECT_FEEDS`. Don't guess URL
  shapes at an outlet — the probe reads a 200's body and names what came back
  (HTML page / XML root / empty feed), and when a candidate resolves to an
  HTML page it follows the feed the page itself DECLARES
  (`<link rel="alternate">`) — asking the page beats suffix-guessing, which is
  what disproved 28 staged candidates. Pinned by `verify-feed-probe`.
- **Direct outlet feeds AND site sweeps are prefiltered** (`isWorthClassifying`):
  a national daily's firehose is mostly football/crime, and every item would
  otherwise cost a classifier call. SITE_FEEDS were exempt as "query-scoped" —
  disproven 5 Aug: Google News does not reliably honour the brand conjunction
  in `(site:…) (brands)` and returned Al Mal's/Reuters' general firehose
  (412 of 944 rows in 7d, 0 relevant), halving the Health screening rate.
  Only the 10 quoted brand queries in FEEDS bypass the filter; sector stories
  naming no brand still pass it.
- **Author extraction is first-VALID-wins** across all sources (JSON-LD →
  metas → visible bylines) — junk in a high source must never mask a lower
  real byline. Junk classes already filtered: outlet names, UI placeholders,
  emails, photo credits (تصوير/أرشيفية).
  **And RAW MARKUP is not a byline** (6 Aug, user-reported): an Astro page filed
  `بريد-لتسهيل-تقديم-التظلمات" data-astro-c` as the author — the tail of an href
  slug, the closing quote, and the start of `data-astro-cid-*`. Several byline
  patterns capture `[^<]{2,60}` after hopping to the first `>`, so an attribute
  VALUE containing `>` lands the hop INSIDE the tag and the capture runs from
  mid-attribute into the next one. The reason nothing objected is the real
  lesson: `cleanAuthor` returned a **single-segment** candidate unchecked —
  `looksLikePerson` only ever ran on names that split into segments, so a lone
  blob of markup was waved through. Guards now sit in `cleanName`, below every
  source: `MARKUP_JUNK` (a name has no `<>="{}`, no `data-`/`aria-`, no
  `href=`), `looksLikeSlug` (two hyphens in one whitespace-free token is a path
  segment, not Jean-Pierre), and `NAME_SHAPE` on the single-segment path. Word
  count is deliberately NOT capped there — Egyptian bylines run to five parts
  (`أحمد محمد عبد الله السيد`), and `looksLikePerson`'s 2–4 cap guards the
  multi-segment split only. Hardening each regex would be whack-a-mole; the
  funnel's bottom holds for JSON-LD, metas, bylines, datelines and the AI alike.
  **A stored junk byline is never revisited** — the backfill selects
  `author=is.null`, so a wrong name is permanent until someone NULLs it. Two
  live rows carried residue; both cleared 6 Aug with user approval.
  Pinned by `verify-author-markup`.
  **This was the third byline bug in a week, each fixed somewhere different** —
  so validation was consolidated into ONE funnel, `judgeByline` +
  `BYLINE_RULES` (`lib/author.js`), where every rejection carries the rule's
  NAME. Three things follow, and they are the whole reason it is worth the
  indirection: a new lesson is one entry in one list; `extractAuthorFromHtml`
  takes `{trace}` and reports which source produced a candidate and which rule
  killed it (so `inspectAuthorPage` can say *why*, where it used to report only
  the story-subject refusal and read as a flat "no byline"); and LOOSE
  extraction patterns became safe to add, because nothing reaches the board
  without passing the same rules — `itemprop=author`, `class="…author…"` and
  `<address>` went in on that basis, all previously unread. `cleanNameChecked`
  is the bare-string face for callers holding no page (RSS `<dc:creator>`, the
  model's answer). **Reported cases live in `tests/byline-cases.mjs` and the
  loop for adding one is the playbook below** — read it before touching this
  code. Pinned by `verify-byline-cases`.
  **And the SUBJECT of a story is not its author** (6 Aug, user-reported): an
  Ahram Online interview was filed with the byline of the CEO being interviewed,
  and two Arabic cards credited the person quoted in their own «X: quote»
  headline — the board attributed words to named people as if they had written
  them, which is worse than an honest "—". The AI prompt ALREADY forbade "a
  person merely mentioned or quoted IN the story (an official, a CEO)", so this
  is the recurring lesson: a judgement the model gets wrong needs a
  DETERMINISTIC guard beside the instruction. `isStorySubject()` +
  `isNamedInHeadline()` (`lib/author.js`) now gate EVERY candidate on both paths
  — an interviewee reaches JSON-LD and `<meta name=author>` too, so the check
  cannot live only on the AI answer. Signals: a name beside a job title, a name
  introduced by a quote verb, or a name that appears in the headline. Two
  calibration traps, both found by the test: the ROLE window must stay ~30 chars
  (wider, and an unlabelled byline above a paragraph about a minister is thrown
  away) and the quote verb must be IMMEDIATELY adjacent (`X said` / `said X`) —
  at 22 chars it rejected the real byline in `Fintech Gate: Riham Ali` /
  `Vodafone Egypt said …`, the commonest shape in news copy. An explicit `By` /
  `بقلم` / `كتب` before the name overrides everything. The headline is now
  THREADED from all three callers (`fetchAuthor`/`fetchAuthorProbe`/
  `inspectAuthorPage` take `{ headline }`) and passed to the model as context.
  `author-inspect` reports rejected names as `subjects`, so the panel can't read
  "no byline" for a page that plainly shows one.
  **The same page then showed the OTHER half of the bug** (user-reported minutes
  later): its real byline is `Doaa A.Moneim , Thursday 6 Aug 2026` — no "By", no
  byline class, and Ahram links journalists as `/Search.aspx?author=…`, a QUERY
  param the `/author/` PATH pattern missed. So the cascade found nothing and the
  AI read the body. Worse, the first version of the guard would have REJECTED
  her: flattened, the text runs `…3 mln users: Axis CEO Doaa A.Moneim , Thursday
  6 Aug 2026`, so the headline's own "CEO" sits nine characters before the
  journalist's name. Rule that resolves both: **positive byline evidence wins** —
  a name followed by a DATELINE is a byline (`DATELINE_AFTER` exempts it from the
  subject check, exactly as an explicit `By` does), and `datelineCandidates()`
  now EXTRACTS that shape from the flattened opening (1500 chars, separator
  required) as the lowest-priority source. It walks back over tokens and stops at
  an ALL-CAPS token or a role word, or the run climbs out of the byline into the
  headline. Do NOT rebuild it as one regex with the `i` flag: under `i`,
  `\p{Lu}` matches lowercase too, and the capture swallowed whole clauses
  ("its network Mona Said") — the test caught it. #1960 now reads
  `Doaa A.Moneim`; #886 and #430 stay NULL (unknown, never guessed) and will be
  re-probed by the backfill. Pinned by `verify-author-subject`. Tag/keyword/search archive URLs are
  killed at ingest (`isNonArticlePage`), and so are personalised share cards:
  a `/share` path segment, or a full phone number as a query VALUE — a Vodafone
  Cash year-in-review page slipped past the newsroom sweep and the daily brief
  mailed a private mobile number to the list as a "win" (live, 5 Aug).
- **The weekly email output must stay byte-identical** unless intentionally
  changed — `buildReportRange` was added *beside* `buildReport` for this
  reason. Email HTML is table-layout + inline styles only.
- **One design system across surfaces.** `lib/email.js` carries the BOARD's
  tokens (`public/index.html` `:root`) and exports them as `THEME` for
  `lib/report.js`, so bulletin + urgent + welcome + report + board match. Change
  a board token → update the email constants in the same commit
  (`render-email-design` reads `:root` and asserts on all three templates). Card vocabulary is shared too: Impact,
  "What to do with this", and the lane names Needs a response / Wins to
  amplify / Market & noted.
- **Inline styles sit inside `style="…"`** — never use double quotes within a
  declaration (a `"Segoe UI"` in the font stack truncated every property after
  it and silently killed colours). Single quotes only; the test guards it.
- **Narratives are two-stage AND two REQUESTS** (`lib/narratives.js`): a
  deterministic token pre-pass, then an LLM pass (Haiku, `NARRATIVE_MODEL`) that
  re-groups and writes the English title.
  **The LLM pass is OFF the Trends load path.** `/api/stats` used to `await
  buildNarratives()` inline, so on a cold request every chart on the screen —
  share of voice, sentiment, categories, both leaderboards, the KPI row — waited
  on a 12-second ceiling for ONE card: the whole screen was as slow as its
  slowest optional part. Now `/api/stats` returns the deterministic clustering
  (`{ ai: false }` — stage 1 runs either way, so it is free) and the card is
  populated on FIRST PAINT; `stats.html` then fetches
  **`/api/stats?view=narratives`** and swaps in the better grouping, marking the
  card "refining…" meanwhile. `narrativesPending` is false with no
  `ANTHROPIC_API_KEY`, so a deployment without one never fires a request that
  can only return what it already has. A stale answer is dropped by sequence
  number (`narrSeq`) so a 30-day result never paints over a 7-day board, and a
  FAILED upgrade renders **no error state at all** — nothing is missing, only
  un-upgraded. Pinned by `render-narratives-async`, which asserts zero Anthropic
  calls from `/api/stats` with the key CONFIGURED (so it cannot pass for the
  wrong reason on a keyless machine) and that ids/idsTotal/`NARR_IDS_MAX`
  survive the split. Stage 2 is fail-soft and optional — no
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
- **Trends opens with "So what?", and every line is DERIVED ARITHMETIC.** A
  chart answers "what does the shape look like", which is the second question;
  the first is "what changed, and who do I talk to", and a PR reader was
  deriving it by eye from five cards each morning. `execInsights()`
  (`stats.html`) computes up to five findings from the SAME arrays the charts
  render — Vodafone-negative movement half-window over half-window, a rival
  gaining share, the category carrying the most criticism, the outlet and
  byline driving it, and how many narratives are still rising. **No request and
  no model**: a second aggregation could disagree with the card underneath, and
  an LLM headline is exactly the thing that must not be guessed here. Three
  honesty bars, all asserted: a comparison needs **two days a side** (or there
  is no previous period), a percentage needs a **non-zero baseline** (a rise
  from nothing prints counts and no `%`), and an outlet or byline needs
  **≥2 Vodafone-negatives** (one negative is an article, not a stance). When
  nothing clears the bars it SAYS SO — a strip that always finds five things is
  one nobody believes by the second week. Pinned by `render-exec-strip`.
- **Trends exports are PER CARD** (⤓ XLS / ⤓ PDF next to each card's ⊞ Table),
  never a page-wide bar — you export the section you are looking at, and the
  filename is named after it. `sectionsFor(cardId)` maps a card's DOM id to its
  section — including `c-kpi`, the KPI row, which carries the Summary totals and
  is a section like any other despite not being a `.cardc`. Passing no id
  exports everything; nothing in the UI does that. They are built in the BROWSER, from the same `DATA` the screen renders — no endpoint, no second aggregation that could disagree with what you
  just looked at, and no new dependency. Excel is an Excel-flavoured HTML
  workbook (`.xls`, one `x:ExcelWorksheet` per section — names ≤31 chars, no
  `[]:*?/\`; each table also carries a title row so a reader that flattens the
  workbook still gets labelled sections). PDF is a print-ready page that embeds
  each chart's LIVE `<svg>` and calls `window.print()` — the same
  browser-print route `public/reports.html` uses, so still zero PDF libraries.
  Chart lookup must be `#id .cbody > svg` (**direct child**): a list card's rows
  each contain a sparkline, and a descendant match pasted one in as the section
  chart. Exports carry EVERY leaderboard row, not the visible page. Pinned by
  `render-trends-export`.
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
- **A controversy the brand is NOT a party to is still negative for it** — a
  plagiarism row over the music in a Vodafone ad, a scandal about a campaign's
  celebrity, a contractor's misconduct on its project. "The brand did nothing
  wrong, so neutral" is the tempting wrong answer, and the classifier gave both
  answers to the same story 90 minutes apart (live, 2026-07-31). The rule now
  lives in the sentiment section: subject-of-the-controversy ⇒ negative;
  not-the-accused softens **severity** (2–3), never the sentiment.
  **And its follow-ups stay RELEVANT** — the sentiment rule alone was not
  enough: two later chapters of the same plagiarism row ("the Tawlet song is
  taken down") arrived with no brand in the headline, the classifier CONNECTED
  them (`brand: Vodafone`) and still filed them irrelevant as music news
  (live, 5 Aug; user decision to include). The scope section now says a story
  the model can connect to a brand-linked controversy/campaign is relevant even
  with the brand unnamed, and that brand-set + is_relevant:false is confined to
  non-Egypt/duplicate cases. **And an unnamed «شركة اتصالات» is never e&** —
  the word اتصالات is generic Arabic for telecom, and Egyptian press
  deliberately withholds the operator's name in accusation stories; the
  classifier once pinned such an accusation (actually Vodafone — the Inas
  Ezzeddin 5-lines case, 5 Aug) on e&. Unnamed operator ⇒ brand `market`,
  never a guess; the Context doc may supply the name. Judgement calls like
  this get written into the prompt and pinned by `verify-judgement-rules`,
  which asserts on the exported `SYSTEM` string.
- **A duplicate is COVERAGE, not garbage.** Within a run `fuzzyDedupe` always
  kept every cluster member as a `pr_instances` row; across runs all four passes
  (hash, headline Jaccard, summary hash/Jaccard, semantic) just filtered the
  item out, so a story re-published hours later by another outlet lost that
  outlet AND its byline, and "◱ N outlets" only ever counted one run (fixed
  2026-08-01). They now record `{item, intoId}` in `mergedAway` and write the
  outlet against the stored card. `existingHashes`/`existingSummaryHashes`
  return a **Map** (hash → id) for this — use `.has()` to decide "already
  stored" and `.get()` only for the merge target, or a row without an id
  re-ingests as a new card. `recentStories()` selects `id`; `semanticDedupe`
  takes an `onMerge(item, intoId)` callback. Runs report `mergedIntoExisting`
  so `new: 0` doesn't read as "nothing happened". Pinned by
  `verify-crossrun-merge`. **Coverage counts OUTLETS, not stored rows** — the
  same article arrives as a Google-News redirect AND its resolved link, so
  `uniqOutlets()` (board + `lib/email.js`, mirrored) collapses by outlet, keeps
  the publisher's link and carries the byline across from whichever row has one.
  `mergeDuplicateInto` uses the duplicate's INSTANCES when it has any, never
  those plus its own `url` — doing both wrote one article twice and a card read
  "3 outlets" for a single publisher (live 2026-08-01). Pinned by
  `render-coverage`.
  The residue ingest is NOT sure about is a human
  call: **Admin → Tools → "Find duplicates"** (`?view=find-dupes`, read-only)
  lists candidate pairs from production with scores, and `merge-dupe` folds one
  into the other. Merging hides the duplicate with **`is_relevant`, not
  `team_share`** — a `team_share` hide leaves the row counting in Trends, so the
  story stays double-counted in analytics. `lib/dedupe.js` holds the one
  tokenize/jaccard the pipeline and the finder share; don't re-implement them
  (`dedup-jaccard` used to scrape them out of `api/radar.js` source).
- **Two write-ups of one event must become one card.** That pair also escaped
  every dedupe layer: the cross-run summary Jaccard was 0.429 against a 0.5 bar,
  and the semantic backstop (which DID see the pair — 6 shared strong tokens)
  answered "different events" because the paraphrases transliterated the names
  differently (Walid/Waleed, Tawlet/Too Late). `SAME_EVENT_SYSTEM` now names
  disputes as a same-event pattern and tells the model Arabic names have many
  spellings — while keeping its unsure⇒keep fail-safe, since losing a real story
  is worse than a duplicate card.
- **The board's "next scan" countdown is computed, not fetched** — the urgent
  cron fires on the quarter hour in UTC and Cairo is a whole-hour offset, so the
  minute hand is the same either way. If the cron in `vercel.json` ever changes
  cadence, `SCAN_EVERY_MIN` in `public/index.html` must change with it or the
  timer lies. It also nudges `checkNew()` ~75s after each fire so new stories
  land without waiting out the 5-minute poll. Pinned by `render-autorefresh`.
- **Admin → Health is the only surface that can tell you the pipeline is
  broken**, and every check on it is calibrated to PR Radar's actual numbers,
  not the Regulatory Radar's — the shapes are different enough that copying its
  thresholds would produce a page that cries wolf. Three that matter:
  **the daily brief legitimately does not send**. `api/radar.js` builds the
  digest from the last 24h of relevant items at `importance >= 2` and skips both
  send loops when that set is empty — which happened on 1 and 2 Aug. So the
  bulletin check reads the marker AND `digestEligibleCount()`. Both halves are
  measured against the SCHEDULE, not the wall clock: "late" is `marker < the last
  05:00 UTC run` (`lastBriefDueAt()`, +1h grace so a run in flight is not called
  late), and the evidence is `digestEligibleCount({until: dueAt})` — what the
  digest would have carried AT that run. Counting what is queued NOW fired a
  CRITICAL at 01:08 Cairo on 3 Aug with 5 queued and **0** that had existed at
  05:00Z: the brief was not late, it was not yet due (live-verified). Gating on
  the marker alone would sit red through every quiet week until nobody read it.
  `BRIEF_CRON_UTC_HOUR` must track `/api/radar` in `vercel.json` or the check
  judges against a schedule the app no longer runs.
  **Screening quality is measured over whole weeks**, not 24h-vs-same-weekday
  (which is what RR does): PR Radar's daily relevance rate swings 0.0%–11.9% on
  1–15 relevant stories out of 55–175 scanned, so a day-on-day test is noise.
  7d vs the prior 3 weeks pools ~700 against ~2100 and cancels the weekday
  effect without modelling it. **Bylines are judged as a SHARE** (warn at 75%),
  because ~42% of relevant cards have no author and never will — Egyptian wire
  and desk copy is unsigned, so a raw count is meaningless.
  Pinned by `verify-health-checks` + `render-health-tab`.
- **A ledger must never be able to fail the job it watches** (`lib/runs.js`).
  A monitoring table that can take down the ingest it monitors is a worse bug
  than the blindness it was added to fix — so every function there swallows
  everything, and the caller cannot tell "recorded" from "not recorded". There
  is deliberately **no try/catch around the radar pipeline**: a run that throws,
  or is killed at the 60s function cap, leaves its row `running`, and the
  stalled-run check reports that. A catch would record the throw and MISS the
  timeout, which is the failure this app is actually near. `?dry=1`/`?debug=1`
  are not recorded — they are diagnostics, and they would pollute the one
  question the ledger exists to answer. Both ledgers degrade to **`unknown`**,
  never to an alarm: "the table is absent" and "nothing ran" are opposite facts,
  and guessing the alarming one puts the page permanently red on the very
  database it should reassure you about. Pinned by `verify-ledgers`.
- **A parked story is invisible everywhere except Admin → Health.** When the
  classifier returns no verdict, `classify.js` stores the item
  `category:'unclassified', confidence:0, summary:null, is_relevant:false` —
  correct (never guess), but it means an API error or a spend cap looks exactly
  like a quiet news day on the board, in the brief and in the logs. Live: 100
  parked in the 7 days to 2 Aug, in bursts of 6–68. That is what the spend gauge
  (`lib/usage.js` → `pr_usage`) exists to catch on the way up rather than after.
- **`db_size_bytes()` is the other app's function — call it, never define it.**
  It already exists in the shared project and returns one number for the WHOLE
  database. PR Radar's storage check calls it read-only. A `create or replace`
  from this repo would be reaching into shared state, which the hard rules
  forbid; the number is honest anyway, because the tier ceiling is shared too.
- WhatsApp preview caches are sticky — test OG changes with a `?v=N` URL.

## When a wrong byline is reported

Bylines are the one field users check against the source, so this is the most
frequently reported class of bug — three in the first week of August. Each was
fixed in a different place, which is how the next one was guaranteed. The loop
below is the fix for THAT, and it is not optional; the whole point is that a
report costs one ledger entry instead of an hour of regex archaeology.

1. **Add the case FIRST, and watch it fail.** `tests/byline-cases.mjs` is a data
   table: `REJECT` (what must never be stored) and `ACCEPT` (real names a guard
   must not eat). Record `reported`, `outlet`, `why`, and either `raw` (a bare
   candidate) or `html` (run through the whole cascade). A case written AFTER
   the fix only proves the fix exists, not that it answers what was reported.
2. **Diagnose with the trace, not by reading regexes.** `extractAuthorFromHtml`
   takes `{ trace: [] }` and fills it with `{source, raw, ok, reason}` for every
   candidate; Admin → Tools → "Verify verdicts" shows it per card. The reason
   names the rule, so you learn immediately whether the value was never
   extracted (a coverage gap) or extracted and wrongly accepted (a rule gap).
3. **Fix in ONE place: `BYLINE_RULES` / `judgeByline` (`lib/author.js`).** Every
   rejection rule lives in that one ordered list with a name. Resist adding a
   guard beside the pattern that leaked — that is the scattering this replaced.
   A coverage gap is the exception: add the pattern to `bylineCandidates`, which
   is safe precisely because everything it emits is vetted by the same funnel.
4. **Sweep production for the same fault, then clear it.** A stored byline is
   NEVER revisited — the backfill selects `author=is.null` — so a wrong name is
   permanent. Read-only SQL over `pr_items` finds siblings (the Astro case had
   one, at a different outlet); NULLing them is a data write, so **ask first**,
   then let the nightly backfill re-resolve.
5. `npm test -- byline` replays the ledger. Every earlier case must still pass —
   that is the actual guarantee being maintained.

Two rules that outrank any clever extraction: **an honest blank beats a
confident wrong name** (the board renders `—` / newsroom, and that is a
supported outcome, not a failure), and **a judgement the model gets wrong needs
a deterministic guard beside the instruction** — firming up the AI prompt has
never once been sufficient.

## Verifying work

1. `node --check` changed files; `npm test` green (browser tests need Chromium).
2. Pipeline changes: `/api/radar?dry=1` (no side effects), `?debug=1`
  (per-story funnel trace), `?to=you@x` (real daily send to one address).
3. Author work: Admin → Tools → "Backfill authors" + "Verify verdicts"
  (live per-card evidence: outcome, page text, per-profile fetch statuses).
4. Alert work: Admin → Tools → "Send test to myself" (`?resource=alert-test`)
  sends a sample through the real `renderUrgent`/`sendBulletin` at a chosen
  tier — always to the signed-in admin only, never the subscriber list.
  "Send test alert" beside it is **WhatsApp-only** and template-blocked, so it
  proves nothing about email. To send a REAL alert for a REAL card (a
  correction that missed its ingest-time alert), use the board card's **🔔** —
  that one DOES reach the full alert list; see the instant-alert Gotcha.
5. User work: Admin → Users → **Add a user** provisions for real — it sets a
  password in Supabase Auth and PUTS MAIL IN SOMEONE'S INBOX, so test it on an
  address you own, or untick **Email sign-in** and read the response panel. The
  panel is the only place the starter password is ever shown.
6. Password resets: tap **Forgot password?** on `/login` with your own address —
  it should answer "Request sent", put a row in Admin → Requests and mail
  `ADMIN_EMAILS`. Before the migration is applied it answers the same and
  records nothing, which is the designed degradation, not a failure.
7. **Admin → Health** — up to 18 live checks + 14-day alert history, computed
  on open. The first three answer "what am I even looking at": the **deployed
  build** (running commit vs `origin/main`), the **schema migrations** this
  database has, and whether the **scheduled jobs actually ran** (recorded, not
  inferred — plus a completion check that catches a run killed by the function
  timeout). Five answer "did it run?" by outcome" (brief freshness vs stories waiting, ingest
  volume, parked stories, recipients, dead feeds). Seven answer harder
  questions: **screening quality** (7d relevance rate vs the prior 3 weeks),
  **byline backfill** (share, not count), **weekly report** (reads `off`, not
  broken, while `REPORT_EMAIL_ENABLED` is unset), **API spend** (month-to-date +
  month-end projection), **deliverability** (the provider's own per-message
  status — everything else only knows the send was *accepted*; scoped to
  `RADAR_FROM`'s address because the Resend account is shared, so the other
  app's ~18 daily sends neither pad nor redden this check), **storage
  headroom** (shared DB, shared ceiling), **prompt-cache reuse** (broken caching
  raises the bill with no other symptom; reads `ok — not used` when every run was
  a single batch, which is the normal shape). `GET /api/alerts?notify=1` is the push
  — emails only on warn/crit, deduped on the subject for 22h; fired daily 05:45.
8. After deploy: Vercel MCP (runtime logs), Resend MCP (did mail send),
  Supabase MCP read-only SQL (did rows change). `pr_state.daily_bulletin_sent`
  tells you when the brief last actually went out.
