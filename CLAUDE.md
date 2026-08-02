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
| `api/*.js` | Vercel functions only. `radar.js` = ingest pipeline (feeds → dedup → classify → store → alerts/bulletins/backfills); `stats.js` trends aggregation (narratives live in `lib/narratives.js`); `report.js` weekly/custom reports + Word export; `alerts.js` (pipeline health checks + the daily push); `admin.js`, `auth.js`, `go.js`, `geo.js`, `verify.js` |
| `lib/*.js` | ALL shared logic. `sources.js` (feeds + the direct-feed relevance prefilter), `feed-candidates.js` (STAGING only — probe before promoting), `db.js` (PostgREST `rest()` + every query), `auth.js` (roles/audit), `email.js` (email-client-safe renderer + `sendOpsAlert`), `classify.js` (classifier prompt, cached system block), `author.js` (byline extraction), `author-backfill.js`, `resolve.js` (Google-News decode + `isNonArticlePage`), `dedupe.js` (shared tokenize/jaccard + the admin duplicate-finder), `dedupe-semantic.js`, `narratives.js` (two-stage narrative clustering), `report.js`, `surge.js`, `whatsapp.js`, `notify.js`, `geo.js`, `usage.js` (per-call token accounting), `deliverability.js` (provider-side send status) |
| `public/*.html` | Self-contained pages (inline CSS/JS, no imports). Session = `pr_session` in localStorage + `afetch()` Bearer wrapper. API downloads must go fetch→blob (links can't carry the header) |
| `migrations/*.sql` | Optional, **manually applied**, each with a WHY/WHAT/SAFETY header. Never auto-applied — the code must work without them |
| `scripts/` | One-off generators run manually (OG images) |
| `tests/*.mjs` | The suite. `narr-fixture.mjs` is captured production data, not a test |

New shared behaviour goes in `lib/` and is imported by `api/`; never duplicate
logic into a function file. New pages get a rewrite in `vercel.json`.

## Services

| Cron (vercel.json) | Schedule (UTC) | Notes |
|---|---|---|
| `/api/radar` | daily 05:00 | full run: ingest + daily bulletin (`RADAR_TO` + subscribers) + stored-author backfill |
| `/api/radar?urgentOnly=1` | every 15 min | ingest + severity-5 instant email/WhatsApp; skips bulletin |
| `/api/report?period=week&send=1` | Mon 06:00 | no-op unless `REPORT_EMAIL_ENABLED=1` |
| `/api/geo?send=1` | Mon 07:00 | no-op unless `GEO_ENABLED=1` |
| `/api/alerts?notify=1` | daily 05:45 | health push — silent unless a check is warn/crit, and deduped on the subject so a chronic problem mails once, not daily |

Sources (`lib/sources.js`): 10 brand/market Google-News queries (AR+EN) + 7
site-scoped sweeps covering the team's named outlet list + 13 direct outlet RSS
feeds (the only ones that carry a byline) = 30 daily. The 15-min urgent poll
runs the 10 brand queries only. Direct feeds are probe-verified; 31 unverified
candidates remain staged in `lib/feed-candidates.js`.

Integrations: Supabase (service-role key, PostgREST), Anthropic (classifier +
byline fallback + narrative grouping), Resend (all email), WhatsApp Cloud API
(`WHATSAPP_*` now SET in Vercel — sends reach Meta but are refused until the
`pr_urgent` template is approved; the official API cannot post to groups, DMs
only).

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
| `pr_users` / `pr_audit` | Sign-in allowlist + roles; audit trail. **Live-only: missing from schema.sql** (see Drift) |
| `pr_state` | Key/timestamp markers (`daily_bulletin_sent` idempotency) |
| `pr_subscribers` | Daily-digest mailing list (categories[] filter; ≠ users) |
| `pr_context` | Admin-editable house knowledge injected into classification |
| `pr_feed_health` | Per-feed failure streaks (bulletin footer) |
| `pr_feedback` | In-app feedback form |
| `pr_alerts` / `pr_usage` | Alert history + per-call token accounting (Admin → Health). **Applied 2 Aug** via Supabase MCP with user approval, from `migrations/2026-08-02-*.sql` |

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

## Drift (repo ↔ live, verified 2026-08-02)

| Where | Fact |
|---|---|
| `schema.sql` | Missing `pr_users` + `pr_audit` (created ad-hoc in prod). Add them (idempotently) next time schema.sql is touched — with user approval |
| Vercel env | `RADAR_TO` unset → the **team/admin** copy of the daily brief doesn't go out; the brief itself does, via the subscriber path, which never reads `RADAR_TO` (5 active subscribers, 2 Aug). Adding recipients is better done in Admin → Subscribers than here — the var needs a dashboard edit **and** a redeploy. Set **`OPS_ALERT_TO`** too, or the daily health push records its alert and reaches nobody (it falls back to `RADAR_TO`) |
| `pr_state.daily_bulletin_sent` | Reads **22 Jul** and that is CORRECT, not drift: the marker now stamps on any send, and nothing has cleared the Impact-2 digest bar since — 0 eligible on 1 and 2 Aug (`pr_items`, verified). Admin → Health reads the two together for exactly this reason |
| `pr_items` | 100 stories parked `unclassified` in the 7 days to 2 Aug (bursts of 6-68 on 25, 28, 29, 30 Jul and 1 Aug). Cause unconfirmed — Health's Classification check now surfaces it; if it keeps bursting, look at the classify batch's error path before the prompt |
| Meta | `pr_urgent` WhatsApp template submitted 31 Jul, still *In review*. Until Meta approves it every send returns `#132001`. Language is English, so the `en` default is right — if it ever shows "English (US)", set `WHATSAPP_TEMPLATE_LANG=en_US` |
| `api/radar.js` comments | Mention a 04:10 GitHub Actions backup cron — no workflow exists in this repo (unconfirmed origin) |

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
  `N/5` and carries no label. **Only 5 alerts in real time**; a 4 waits for the
  05:00 brief.
- **Instant alerts fire on `isInstantAlert` (`lib/email.js`), not on Impact 5.**
  Impact 4-5 **or** any negative *Vodafone* story at any Impact — a bad story
  about us shouldn't wait out the 05:00 brief because its pickup was small. The
  brand check is load-bearing: sentiment is the story's own tone for the brand it
  names, so without it every rival outage would page the team; a rival's negative
  alerts only if it also scores 4+. `urgentTier()` sits beside the rule and
  drives the badge, the "why it fired" line **and** the subject in `api/radar.js`
  — only Impact 5 says URGENT, everything else says ALERT, because labelling all
  of it URGENT is how an alert channel earns being ignored. Both live in
  `lib/email.js` so the trigger and the wording cannot drift. ~1 alert / 5 days
  on the history to 1 Aug. Pinned by `verify-urgent-recipients` (including the
  must-NOT-fire cases). Changing the rule means changing the guide's two urgent
  blurbs and the alert footer in the same commit.
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
  reads `:root` and fails otherwise). Card vocabulary is shared too: Impact,
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
  not-the-accused softens **severity** (2–3), never the sentiment. Judgement
  calls like this get written into the prompt and pinned by
  `verify-judgement-rules`, which asserts on the exported `SYSTEM` string.
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
  bulletin check reads the marker AND `digestEligibleCount()`: stale marker with
  nothing waiting is `ok`, stale marker with stories waiting is `crit`. Gating on
  the marker alone would sit red through every quiet week until nobody read it.
  **Screening quality is measured over whole weeks**, not 24h-vs-same-weekday
  (which is what RR does): PR Radar's daily relevance rate swings 0.0%–11.9% on
  1–15 relevant stories out of 55–175 scanned, so a day-on-day test is noise.
  7d vs the prior 3 weeks pools ~700 against ~2100 and cancels the weekday
  effect without modelling it. **Bylines are judged as a SHARE** (warn at 75%),
  because ~42% of relevant cards have no author and never will — Egyptian wire
  and desk copy is unsigned, so a raw count is meaningless.
  Pinned by `verify-health-checks` + `render-health-tab`.
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
  proves nothing about email.
5. **Admin → Health** — 12 live checks + 14-day alert history, computed on
  open. Five answer "did it run?" (brief freshness vs stories waiting, ingest
  volume, parked stories, recipients, dead feeds). Seven answer harder
  questions: **screening quality** (7d relevance rate vs the prior 3 weeks),
  **byline backfill** (share, not count), **weekly report** (reads `off`, not
  broken, while `REPORT_EMAIL_ENABLED` is unset), **API spend** (month-to-date +
  month-end projection), **deliverability** (the provider's own per-message
  status — everything else only knows the send was *accepted*; scoped to
  `RADAR_FROM`'s address because the Resend account is shared, so the other
  app's ~18 daily sends neither pad nor redden this check), **storage
  headroom** (shared DB, shared ceiling), **prompt-cache reuse** (broken caching
  raises the bill with no other symptom). `GET /api/alerts?notify=1` is the push
  — emails only on warn/crit, deduped on the subject for 22h; fired daily 05:45.
6. After deploy: Vercel MCP (runtime logs), Resend MCP (did mail send),
  Supabase MCP read-only SQL (did rows change). `pr_state.daily_bulletin_sent`
  tells you when the brief last actually went out.
