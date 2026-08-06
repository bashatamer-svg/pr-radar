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
| `lib/*.js` | ALL shared logic. `sources.js` (feeds + the direct-feed relevance prefilter), `feed-candidates.js` (STAGING only — probe before promoting), `db.js` (PostgREST `rest()` + every query), `auth.js` (roles/audit + `provisionUser`/`presetPasswordFor`/`adminCreateUser`), `email.js` (email-client-safe renderer + `renderWelcome` + `sendOpsAlert`), `classify.js` (classifier prompt, cached system block), `author.js` (byline extraction), `author-backfill.js`, `resolve.js` (Google-News decode + `isNonArticlePage`), `dedupe.js` (shared tokenize/jaccard + the admin duplicate-finder), `dedupe-semantic.js`, `narratives.js` (two-stage narrative clustering), `report.js`, `surge.js`, `whatsapp.js`, `notify.js`, `geo.js`, `usage.js` (per-call token accounting), `deliverability.js` (provider-side send status) |
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
| `pr_context` | Admin-editable house knowledge injected into classification. **In use since 5 Aug** (one `house_knowledge` row): an "ONGOING STORIES" list naming connections the headlines withhold — the توليت song is a Vodafone ad's music; the Inas Ezzeddin 5-lines case is against Vodafone. This is where story-specific facts belong; the PROMPT carries the general rules. Prune a line when its story dies, or it will eventually mis-tag unrelated news |
| `pr_feed_health` | Per-feed failure streaks (bulletin footer) |
| `pr_feedback` | In-app feedback form |
| `pr_alerts` / `pr_usage` | Alert history + per-call token accounting (Admin → Health). **Applied 2 Aug** via Supabase MCP with user approval, from `migrations/2026-08-02-*.sql` |
| `pr_subscribers.whatsapp` | **Applied 3 Aug** via Supabase MCP with user approval, from `migrations/2026-08-03-pr-subscribers-whatsapp.sql` |

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
  humans = Supabase JWT. The server has enforced this since Task 18, but four
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

- Develop on `claude/pr-radar-improvements-q2yxwr`. **"Merge" = push that
  branch (preview) AND `main`** (production — auto-deploys via Vercel webhook,
  ~1–2 min). A local `prradar/improvements` may linger from an older session;
  it is not on the remote and nothing deploys from it.
- **Other sessions push here too** — `claude/pr-radar-health-alerts-8dbe8c`
  landed Admin → Health on `main` mid-session on 2 Aug. Fetch before pushing and
  REBASE onto `origin/main` rather than forcing over it, then re-run the suite:
  the merged tree is what ships, and neither half was tested against the other.
- **A push to `main` is not proof of a deploy.** The webhook silently missed
  `9e3fcc7` (3 Aug): `git ls-remote` showed `main` at the new SHA, the BRANCH
  preview built, and no production build was ever created — so the live site
  sat on the previous commit and a shipped UI change was simply invisible.
  Confirm with Vercel MCP `list_deployments`: every commit should appear
  TWICE, once `target: null` (preview) and once `target: "production"`. One
  entry alone means it did not ship. Re-trigger with an empty commit pushed to
  `main` — Vercel needs a new SHA, so re-pushing the same one does nothing.
- Does NOT ship with a deploy: env vars (Vercel dashboard only), DB schema
  (manual SQL, ask first), OG images (committed PNGs; regenerate by script).

## Drift (repo ↔ live, verified 2026-08-02)

| Where | Fact |
|---|---|
| `schema.sql` | Missing `pr_users` + `pr_audit` (created ad-hoc in prod). Add them (idempotently) next time schema.sql is touched — with user approval |
| Vercel env | `RADAR_TO` unset → the **team/admin** copy of the daily brief doesn't go out; the brief itself does, via the subscriber path, which never reads `RADAR_TO` (6 active subscribers, 5 Aug). Adding recipients is better done in Admin → Subscribers than here — the var needs a dashboard edit **and** a redeploy. Set **`OPS_ALERT_TO`** too, or the daily health push records its alert and reaches nobody (it falls back to `RADAR_TO`) |
| `pr_state.daily_bulletin_sent` | RESOLVED — advancing daily since the 3 Aug run; read **05 Aug 05:00** on 5 Aug (live-verified). The ten-day freeze was the marker-stamping bug fixed 2 Aug (see the two-recipient-lists Gotcha). **A stale marker is not a missed send** — check Resend, not `pr_state` |
| `pr_items` | **Cause found and fixed 2 Aug** — the bursts (100 parked in the 7 days to 2 Aug) were the classifier omitting items from an otherwise-valid reply, which parsed cleanly and so never retried; see the omission Gotcha. **73** burst-era rows still sit parked in the rolling 7d window (5 Aug; 0 parked in the last 24h — the fix holds) and keep the Health check red until they age out ~6 Aug or are cleared with Admin → Tools → "Re-classify parked stories" |
| Meta | A **new WABA "PR Radar"** was created 3 Aug alongside the old *Test WhatsApp Business Account*; account status Approved, business verification still Unverified. **Templates do not transfer between accounts**, so `pr_urgent` must exist and be APPROVED on whichever WABA `WHATSAPP_PHONE_ID` belongs to. `#132001` cannot distinguish its three causes (unapproved / wrong language code / wrong account) — use **Admin → Tools → "Check account & template"** (`?view=whatsapp-check`), which asks Meta from production and names the fix. Set `WHATSAPP_WABA_ID` if the account can't be resolved from the phone number. The template body carries **TWO variables** — `{{1}}` the story, `{{2}}` the action — because a variable's VALUE cannot contain a newline, so the paragraph break has to live in the template. The send shape must match how they are declared: `WHATSAPP_TEMPLATE_VAR` is a CSV of the variable names in order (default `1,2` = positional; names like `story,action` send `parameter_name`). A mismatch fails as `#132001`, exactly like a missing template |
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
  `N/5` and carries no label. **The BOARD and the BRIEF have different floors** —
  everything `is_relevant` reaches the board, Impact 1 included (5 such cards
  live 2 Aug); the daily digest filters at `importance >= 2`. The guide claimed
  "the board starts at Impact 2" and the prompt justified its scoring floor with
  "so it still reaches the board" — both false, and both sent a reader hunting a
  filter bug for cards behaving as designed. Pinned by `render-guide`.
  **Only 5 alerts in real time**; a 4 waits for the
  05:00 brief.
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
  **(4) The starter-password floor is 6, not the 8 `/api/auth` enforces.** That
  8 governs a password a person CHOOSES; applying it to the generated one would
  rename it for every four-letter first name (`mona123` → `mona1234`) and break
  the only thing the convention is for — an admin saying it without looking it
  up. Only a 1–2 letter first name is topped up (`Ed` → `ed1234`).
  Each step is reported separately (`credentials` / `subscriber` / `emailed`)
  because a provisioned account whose email bounced needs a human to pass the
  password on, and that must not read like a clean run. Both defaults are ON in
  the UI — a checkbox the admin has to hunt for is one that stays unticked.
  Pinned by `verify-user-provision` + `render-user-create`.
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
  General rule for this whole family: a flex row of controls needs an explicit
  give — wrap, scroll, or a hidden child — and `flex:none` on anything whose
  size is part of its usability (touch targets, identity text). A row whose
  siblings are ALL unshrinkable has no give at all: measure it at 320/360/390
  rather than trusting that the flexible child will cope.
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
  emails, photo credits (تصوير/أرشيفية). Tag/keyword/search archive URLs are
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
  proves nothing about email. To send a REAL alert for a REAL card (a
  correction that missed its ingest-time alert), use the board card's **🔔** —
  that one DOES reach the full alert list; see the instant-alert Gotcha.
5. User work: Admin → Users → **Add a user** provisions for real — it sets a
  password in Supabase Auth and PUTS MAIL IN SOMEONE'S INBOX, so test it on an
  address you own, or untick **Email sign-in** and read the response panel. The
  panel is the only place the starter password is ever shown.
6. **Admin → Health** — 12 live checks + 14-day alert history, computed on
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
  raises the bill with no other symptom; reads `ok — not used` when every run was
  a single batch, which is the normal shape). `GET /api/alerts?notify=1` is the push
  — emails only on warn/crit, deduped on the subject for 22h; fired daily 05:45.
7. After deploy: Vercel MCP (runtime logs), Resend MCP (did mail send),
  Supabase MCP read-only SQL (did rows change). `pr_state.daily_bulletin_sent`
  tells you when the brief last actually went out.
