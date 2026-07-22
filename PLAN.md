# PR Radar — Implementation Plan (Claude Code handoff)

**How to use this file:** Drop it into the repo root (e.g. as `PLAN.md`) and run Claude Code from the repo directory. Work the tasks in order — each is self-contained, names the files it touches, and states acceptance criteria. Tasks are independent commits/PRs unless noted. Do **not** batch unrelated tasks into one commit.

---

## 0. Project context (read first)

**What it is.** PR Radar is a daily brand & reputation monitor for the **Vodafone Egypt** PR/comms team. It scans Egyptian news (Arabic + English) for four mobile brands — **Vodafone, Orange, WE, e&** — classifies each story's sentiment *from Vodafone's standpoint*, and delivers a sentiment-first daily email bulletin + a web board, marking who published it, where, and every outlet that ran it. Negative stories are flagged; severity-5 items fire an immediate urgent alert.

**Stack.** Vercel serverless functions (`api/*.js`) + Supabase (Postgres, `pr_*` tables, service-role REST) + Resend (email). Pure ESM, **no build step**, `type: module`. Only runtime dep is `fast-xml-parser`. Classifier is Anthropic Haiku via `fetch` (no SDK). Frontend is a single static file `public/index.html` (vanilla JS, no framework). Daily cron declared in `vercel.json` (`0 5 * * *`).

**Pipeline (`api/radar.js`).** fetch feeds → drop >48h → dedupe (hash → fuzzy → summary → semantic) keeping every outlet as a `pr_instances` coverage row → classify (Haiku, batched 25) → resolve Google-News URL + extract byline → deliver (bulletin email, urgent email + optional webhook, board).

**Key files.**
- `api/radar.js` — the pipeline (orchestrator).
- `api/items.js` — board data (GET) + feedback/pin writes (PATCH).
- `api/go.js` — share redirect: decode Google-News wrapper → real article.
- `lib/sources.js` — Google-News brand/market queries (EN/AR) + 6 verified Egyptian RSS feeds.
- `lib/classify.js` — Haiku classifier (brand, sentiment, severity, category, summary, pr_angle).
- `lib/dedupe-semantic.js` — semantic dedup pass.
- `lib/author.js`, `lib/resolve.js` — byline extraction + publisher-URL resolution.
- `lib/email.js` — bulletin + urgent email renderers/sender.
- `lib/notify.js` — optional urgent webhook (Slack/Teams/WhatsApp bridge).
- `lib/house-context.js` — static house context + admin "living knowledge" block.
- `lib/positives.js` / `lib/negatives.js` — feedback-driven classifier tuning lists.
- `lib/db.js` — Supabase REST helpers (only ever touches `pr_*`).
- `public/index.html` — the whole board UI.
- `schema.sql` — `pr_*` tables (idempotent; safe to re-run).

**Ground rules for every task.**
1. **ESM only**, Node 18+ `fetch`, no new heavy deps unless the task says so. Match the existing terse, comment-heavy style.
2. **Never touch `radar_*` tables** — this app shares a Supabase project with a separate Regulatory Radar and must only read/write `pr_*`.
3. **Batch INSERTs need a uniform key set** across all objects, or Supabase rejects the whole array (PGRST102). If you add a column to inserted rows, add it to *every* row.
4. **Fail-soft**: a monitoring tool must never crash the daily run because one feed/story/webhook failed. Wrap new I/O in try/catch and log; don't throw out of the pipeline.
5. **Secrets stay in env** (see `.env.example`). Never hardcode tokens/keys.
6. **Verify before commit**: `node --check <file>` on every changed `.js`; run a `?dry=1` smoke test where relevant (see each task). Keep a short manual test note in the PR description.
7. Board auth today is a single shared `RADAR_TOKEN` (`?t=` / localStorage). Any new endpoint must enforce the same token check as `api/items.js`.

---

## Phase 1 — Correctness & safety (do first)

### Task 1 — Apply the two already-written fixes ✅ (verify, don't re-derive)

These are done and tested in a prior session; a patch may already be in your inbox (`pr-radar-fixes.patch`). If it's applied, verify and move on. If not, re-create exactly as below.

**1a. `lib/notify.js` — urgent webhook read stale Regulatory-Radar fields.**
Bug: `postUrgentWebhook()` read `item.so_what` / `item.regulator` / `item.tier`, none of which exist on `pr_items`. Every severity-5 Slack/Teams/WhatsApp push went out with a blank action line and `undefined` payload fields.
Fix: parse the **"Action · …"** line out of `item.pr_angle` (not the first line — that's the "Read"), and build the payload from real fields: `brand`, `sentiment`, `importance`, `category`, `country`, `summary`, `pr_angle`, coverage spread from `item._instances`, and the deep link.

**1b. `lib/classify.js` — a failed Haiku batch buried 25 stories.**
Bug: when a batch returned unparseable JSON, the fallback marked all 25 items `is_relevant:false`, silently dropping real coverage.
Fix: a recursive `classifyChunk()` that **splits a failed batch in half and retries down to a single item**, isolating a poison item to itself. Items still unscored are stored `category:'unclassified'`, `confidence:0`, `is_relevant:false` (greppable + counted in a `console.warn`) instead of indistinguishable `'other'`. Keep `classifiedRecord()` and `unclassifiedRecord()` emitting an **identical key set** (PGRST102).

**Acceptance:** `node --check` passes on both; `grep -rn "so_what\|item.regulator\|item.tier" lib api` returns only comments; a stubbed-network unit test shows (i) the webhook text contains the Action line + `Brand · N outlets` and no `undefined`, and (ii) a 4-item batch with one poison item yields 3 classified + 1 `unclassified`, all four with identical key sets. **Commit 1a and 1b separately.**

### Task 2 — Batch "needs review" surfaced in the bulletin (schema-backed, optional but recommended)

Task 1b makes unrecoverable items greppable but still invisible to the team. Close the loop.
- `schema.sql`: nothing new required if you reuse `category='unclassified'`. (Do **not** add a NOT NULL column without a default — existing rows must survive a re-run.)
- `api/radar.js`: after classify, count `is_relevant===false && category==='unclassified'`; pass that count into the bulletin footer next to the existing broken-feeds line.
- `lib/email.js`: render "N stories couldn't be auto-classified today — [board link]" in the footer only when N>0.

**Acceptance:** on a run with an injected unclassifiable item, the bulletin footer shows the count; on a clean run it doesn't appear. `?dry=1` still sends nothing.

---

## Phase 2 — The insight leap (highest business value)

### Task 3 — Trend / analytics view (`/stats`)

**Why:** the board answers "what's happening now" but never "what changed vs last week, and against whom" — the question leadership actually asks. All inputs already exist in `pr_items` (`seen_at`, `brand`, `sentiment`, `importance`, `category`) and `pr_instances` (`outlet`, `author`).

**Backend — `api/items.js` (or a new `api/stats.js`, same token gate):**
- Add a `GET ...&view=stats&days=N` mode returning **server-aggregated** JSON (do the grouping in SQL via Supabase REST/`rpc`, not by shipping every row to the client). Provide:
  - `sovByDay`: per day, per brand — count of items and count of negatives (drives SOV-over-time and "are we trending worse").
  - `sentimentByBrand`: totals of neg/neu/pos per brand over the window.
  - `categoryTrend`: per category, counts over time (network / pricing / vodafone_cash / customer_service / …).
  - `outletLeaderboard`: top outlets by count and by **negative-Vodafone** count (join `pr_instances`).
  - `authorLeaderboard`: same, by byline (author already stored per instance).
- Keep payloads small; cap leaderboards (e.g. top 20) and **log any cap applied**.

**Frontend — `public/index.html` (or a sibling `stats.html`; single-file, vanilla):**
- A `/stats` view reachable from the board header. Reuse the existing CSS variables and Vodafone palette.
- Charts (pick a tiny footprint — inline SVG or one small charting lib via CDN; **no build step**, must render offline-friendly). Consult the `dataviz` skill for palette/mark/legend rules before writing chart code; keep colours colour-blind-safe and consistent with the four brand colours already defined in `index.html` (`BRAND_COLOR`).
  - SOV %-share over time (stacked area/line, 4 brands).
  - Negative-mention volume over time (Vodafone-focused line).
  - Category breakdown + movement.
  - Outlet & journalist leaderboards (tables, negative counts highlighted).
- Respect `prefers-reduced-motion` and `:focus-visible` as the board already does.

**Acceptance:** `/stats?t=TOKEN&days=30` renders without console errors on desktop + mobile widths; numbers reconcile with the board's own counts for the same window; no client-side fetch of raw per-row data when an aggregate suffices. Include a screenshot in the PR.

### Task 4 — Weekly/monthly report export

**Why:** the per-item "Copy brief" is good for one story; the team still assembles the leadership report by hand.
- New endpoint (token-gated) that renders a summary — top negatives, SOV shift, category movement, notable wins — reusing `lib/email.js` render components so styling stays consistent.
- Output HTML (printable to PDF) and/or trigger a Resend send to a chosen address. Vodafone-branded.
- Optionally add a weekly `vercel.json` cron entry (guard with an env flag so it's off by default).

**Acceptance:** endpoint returns a self-contained branded HTML report for a given window; a `?dry=1`-style flag renders without sending. No new required env for the default (send path is opt-in).

---

## Phase 3 — Widen the net

### Task 5 — Social & video listening (largest coverage gap)

**Why:** Google-News + 6 RSS feeds = published press only. In Egypt the earliest/loudest telco sentiment (outages, Vodafone Cash "money stuck", viral complaints) breaks on **Facebook, X, YouTube, TikTok**.
- Extend `lib/sources.js` with a pluggable social-source interface. Prioritise Facebook + X first, then YouTube/TikTok. Prefer official/compliant APIs or a sanctioned aggregator; **respect each platform's ToS and rate limits** — document whatever access route you choose and put keys in env.
- Normalise a social post into the same shape the pipeline already consumes so `classify → dedupe → instances` works unchanged (a post becomes a card/instance like any article).
- Add light authenticity signals (e.g. account age/verification if available) so a coordinated pile-on is distinguishable from organic anger; expose as a field, don't gate on it yet.

**Acceptance:** with a social source enabled, social items flow through to the board/emails classified and deduped identically to news; with the source's env unset, the pipeline behaves exactly as today (fail-soft, no errors). Note in the PR which platforms and access method you used and any coverage caps.

### Task 6 — Near-real-time crisis polling

**Why:** daily 05:00 cron (+ optional hourly urgent) means a 10:00 outage can wait an hour or until next morning.
- Tighten the urgent-only cadence for the **brand queries only** (not the full feed set) — e.g. a 15–30 min schedule that runs `api/radar.js?urgentOnly=1`. Reuse existing hash-dedupe so nothing double-alerts.
- Keep cost bounded: only the brand Google-News feeds between daily runs, full sweep once daily.

**Acceptance:** an injected severity-5 item during an urgent-only run fires exactly one urgent email + one webhook and appears on the board; a normal daily run is unchanged; no duplicate alerts across runs (verify the cross-run hash guard).

---

## Phase 4 — Intelligence & depth

### Task 7 — Cross-item spike / anomaly detection
Maintain a rolling baseline of negative volume per brand/category (store in a small `pr_*` table or `pr_state`). When a run's negative volume for Vodafone (or a category) breaks the trailing baseline by a threshold, raise an aggregate "surge" alert (email + webhook), weighted by coverage spread — not raw count. **Acceptance:** a simulated 3× spike triggers exactly one surge alert with the driving brand/category named; normal volume never triggers.

### Task 8 — Journalist & outlet intelligence
Roll up `pr_instances` by author/outlet over time: sentiment-by-author, repeat-negative flags. Surface in the `/stats` view (Task 3). **Acceptance:** a reporter with multiple negative Vodafone pieces shows an aggregated profile; data matches the underlying instances.

### Task 9 — Narrative clustering
Group same-theme items (using existing `category` + summary similarity) into named, trackable narratives ("Vodafone Cash outage", "roaming price backlash") with volume + sentiment over time; surface "rising narratives". **Acceptance:** items about one event cluster into one narrative with a time series; unrelated items don't merge.

### Task 10 — AI answer-engine (GEO) monitoring *(differentiator, lower priority)*
A lightweight scheduled check that periodically prompts major answer engines (ChatGPT/Perplexity/Gemini) with brand/exec/product questions and flags factual drift or negative framing about Vodafone Egypt. Store as its own source; keep cost bounded and off-by-default via env. **Acceptance:** a scheduled run records the engines' current answers and flags a seeded factual error; disabled cleanly when env unset.

---

## Phase 5 — Admin, reliability & polish

### Task 11 — Surface the `team_share` pin on the board
The pin/hide is **already** plumbed in `api/items.js` (PATCH) and `schema.sql` with pin-expiry, but there's no UI. Add a pin/hide control per card in `public/index.html` and a "Pinned / Saved" filter (the API already supports fetch-by-ids for items outside the window). **Acceptance:** an editor can pin a story and retrieve it via the Saved filter even when it's older than the current window.

### Task 12 — Ship the `/context.html` living-knowledge editor
`lib/house-context.js` + README reference editing `pr_context.house_knowledge` at `/context.html`, but the page isn't committed — so "edit without redeploy" currently means hand-writing SQL. Add a small **token-gated** editor page (textarea → PATCH `pr_context` via a token-gated endpoint mirroring `api/items.js`). **Acceptance:** an admin can edit the living-knowledge block from the browser and the next classify run picks it up (it's injected in `livingKnowledgeBlock()`).

### Task 13 — Confidence & provenance cue
`confidence` is stored but never shown. Add a subtle per-card confidence indicator in `public/index.html` and (optionally) let low-confidence items be filtered. **Acceptance:** confidence renders unobtrusively; existing layout unaffected.

### Task 14 — Subscriber & feedback management UI
`pr_subscribers` and `pr_feedback` have tables but no surface. Add a minimal token-gated admin view to add/remove watchlist subscribers and triage submitted feedback. **Acceptance:** CRUD works against the existing tables; no schema change needed.

### Task 15 — UI polish
Dark mode (CSS is already variable-driven — add a `prefers-color-scheme`/toggle theme), skeleton loading states (replace the plain "Loading the board…"), and a shareable branded snapshot (export the pulse or a card as an image for a Teams/WhatsApp war-room). **Acceptance:** dark mode has adequate contrast (WCAG AA); skeletons show on load; snapshot exports a clean branded image.

---

## Phase 6 — Enterprise readiness *(only if PR Radar scales beyond the core comms team)*

Right-size to actual ambition — do **not** build these for a small trusted team.
- **Task 16 — SSO / RBAC / audit logging.** Replace the single shared `RADAR_TOKEN` with per-user auth (SSO), roles, and an audit trail on writes. Touches all endpoints.
- **Task 17 — GDPR / data handling.** You store author names, URLs and commentary. Add retention limits, a lawful-basis note, and a deletion path before wide deployment.
- **Task 18 — Token hardening & board scale.** Move the board token out of the URL/localStorage to short-lived links or a server session; add pagination/virtualisation to the card list if volumes grow.

**Acceptance (16–17):** these are gates for internal rollout — implement only against a written requirement from comms/security leadership, and treat criticality as High *only* in that scenario.

---

## Suggested order & PR hygiene

1. **Now:** Task 1 (verify/apply), Task 2. Small, pure-correctness.
2. **Next (the insight leap):** Task 3, then Task 4.
3. **Widen the net:** Task 5, Task 6, then Task 7.
4. **Depth:** Tasks 8–10.
5. **Admin & polish:** Tasks 11–15.
6. **Enterprise:** Tasks 16–18 only if scaling.

One task = one focused branch/PR. Every PR: `node --check` all changed JS, a one-paragraph manual-test note (include the `?dry=1` result where relevant), and a screenshot for any UI change. Never commit secrets. Keep the terse in-file comment style of the existing code.

---

## Appendix — reference: the exact Task-1 fixes (already written & tested)

If the patch isn't available, reproduce these two files. Both were verified with a stubbed-network test: the webhook emitted the Action line + `Vodafone · N outlets` with no `undefined` fields, and a 4-item batch with one poison item produced 3 classified + 1 `unclassified` with identical key sets.

The essential logic to reproduce:
- **`lib/notify.js`**: `actionFromAngle(prAngle)` scans `pr_angle` lines for `/^action\s*[·:\-–—]\s*(.*)$/i` and returns the first non-empty match; the `text` is ``🚨 URGENT · ${brand}${spread>1?` · ${spread} outlets`:''} — ${headline}`` then `→ ${action}` then the deep link; the JSON `item` payload carries `headline, url(resolved_url||url), brand, sentiment, importance, category, country, summary, pr_angle, action, outlets, board_url` — and **no** `so_what/regulator/tier`.
- **`lib/classify.js`**: extract `classifiedRecord(src,v)` and `unclassifiedRecord(src)` (identical key sets); add `async classifyChunk(chunk, extraSystem)` that calls the model, maps verdicts back by integer index `v.i`, and on throw splits the chunk in half and recurses (base case: single item → `[null]`); `classify()` maps every source item to a record, counting/ `console.warn`-ing the `unclassified` total. Preserve `hash` on every record so `api/radar.js` can re-attach `_instances` by hash.
