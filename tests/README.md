# PR Radar test suite

Every behaviour shipped to production has a regression test here. All external
I/O is **mocked** (Supabase, Anthropic, Resend, article fetches, WhatsApp) — no
test touches the network or a real database, so the suite is safe anywhere.

## Run

```
npm ci               # exact install from package-lock.json (what CI runs)
npm test             # everything
npm test -- lanes    # only tests whose filename contains "lanes"
```

`package-lock.json` **is tracked**. Use `npm ci`, not `npm install`, so the
version of `fast-xml-parser` that parses hostile feed XML is the one that was
tested rather than whatever npm resolves today.

Browser tests drive headless Chromium. Set `CHROMIUM_PATH` to your Chromium
binary if the default sandbox path doesn't exist; without a browser those tests
are **skipped**, the unit suite still runs.

## What covers what

| Area | Tests |
|---|---|
| Ingest pipeline (feeds, dedup, classify, dry/urgent runs) | `smoke-task6`, `smoke-task1..3`, `smoke-task8..10`, `dedup-jaccard`, `render-debug` |
| Cross-run duplicates merged as coverage, not dropped | `verify-crossrun-merge` |
| Skipped classifier verdicts re-asked, not parked | `verify-classify-gaps` |
| Prompt cache requested only when a read can follow | `verify-prompt-cache` |
| Parked stories re-screened in place, never guessed at | `verify-reclassify-tool` |
| One daily brief per day, even with `RADAR_TO` unset | `verify-daily-once` |
| Severity-5 alerts reach subscribers when `RADAR_TO` is unset | `verify-urgent-recipients` |
| Admin email alert test reaches only the requesting admin | `verify-alert-test-tool` |
| The board's 🔔 fires the real alert late, gated by the live rule | `verify-send-alert-tool` |
| Deliverability scoped to PR Radar's sends, not the shared account | `verify-deliverability-scope` |
| WhatsApp account/template diagnostic (the 3 causes of #132001) | `verify-whatsapp-check` |
| Subscriber editing + WhatsApp number on a subscriber | `render-adminui`, `render-whatsapp` |
| Admin duplicate-finder (scan + merge) | `verify-dupe-tool`, `dedup-jaccard` |
| Auth / RBAC / audit / password flows | `render-auth` (backend), `render-authui`, `render-adminui` (browser) |
| Adding a user provisions them (starter password, brief opt-in, welcome email) | `verify-user-provision` (backend), `render-user-create` (browser) |
| Changing your own password is reachable at every width, by every role | `render-account-menu` |
| Forgot-password: neutral answer, admin queue, self-clearing, no migration | `verify-password-reset` (backend), `render-reset-ui` (browser) |
| Author capture (cascade, AI fallback, ingest-time, backfill, sweep) | `verify-authors`, `verify-ai-author`, `render-poll-author`, `render-author-backfill` |
| An interviewee/quoted executive is never stored as the byline | `verify-author-subject` |
| Scraped tag residue / URL slugs are never stored as the byline | `verify-author-markup` |
| **Every byline mistake ever reported, replayed** (add new ones to `byline-cases.mjs` FIRST — see the playbook in CLAUDE.md) | `verify-byline-cases` |
| Emails & webhooks (bulletin, urgent, report, no-token links) | `render-notoken`, `render-lanes-email-report`, `smoke-task2`, `render-whatsapp`, `send-guard` |
| No `?t=` token in any URL — emails, webhooks **and** every static page | `render-notoken` |
| Custom date-range reports (exec summary, appendix, Word/PDF export) | `smoke-report-range` (backend), `render-reports-page` (browser) |
| Surge detection (calendar + rolling windows) | `smoke-task7`, `render-surge-rolling` |
| Board header fits a phone without crushing the wordmark | `render-header-mobile` |
| Admin list rows on a phone — identity readable, actions wrap beneath it | `render-admin-rows` |
| Card footer on a phone — an admin's 8 controls wrap, none shrink | `render-card-foot` |
| Trends leaderboards on a phone — names readable, bar survives, header fits | `render-leaderboard-mobile` |
| Board UI (lanes, filters, deep links, auto-refresh, bylines, coverage) | `render-task11..15`, `render-lanes`, `render-deeplink`, `render-autorefresh`, `render-desk-byline`, `render-coverage`, `verify-bidi` |
| Sort chip — Impact keeps the lanes, Newest goes flat, neither hides a card | `render-board-sort` |
| Sort stays reachable mid-scroll in its own pinned bar; the lane label follows | `render-sticky-sort` |
| No inline event handlers or javascript: URLs on any page; every data-act has a handler | `verify-no-inline-handlers` |
| Trends narratives (token clustering, LLM grouping + fallbacks, real-data regression, deep-link integrity) | `render-narrative-cluster`, `narr-ai`, `narr-real` (+ `narr-fixture` — captured production rows), `render-narratives`, `render-deeplink` |
| Vodafone-standpoint wording (no bare "negative" on mixed-brand surfaces) | `render-trends-wording`, `render-lanes` |
| Email/board design-token parity + inline-style quoting | `render-email-design` |
| Hostile feed XML — size cap, entity-declaration refusal, one parser | `verify-xml-hardening` |
| Whole app × 6 widths × 2 roles: no pan, no crush, no tiny target, no leak | `render-final-sweep` |
| WhatsApp readiness ladder, the ops alert channel, house-knowledge staleness | `verify-readiness-checks` |
| Sideways-scrolling rows show there is more, without panning the page | `render-scroll-hint` |
| Trends "So what?" strip — derived arithmetic, honest bars, no model | `render-exec-strip` |
| Icon controls have accessible names; result regions are polite live regions | `render-a11y` |
| One session implementation across all seven pages, refresh + sign-out proven | `render-session-shared` |
| Source text is fenced data in all five LLM passes; a forged tag cannot escape | `verify-prompt-injection` |
| Trends never waits on the LLM — first paint clusters, then upgrades | `render-narratives-async` |
| Feed failure streaks increment atomically, never reset to 1 | `verify-feed-streak` |
| Migration + run ledgers: read-only, fail-soft, unavailable ≠ alarm | `verify-ledgers` |
| schema.sql defines every table/column lib/db.js queries | `verify-schema-baseline` |
| Which commit is deployed — reported, never invented; preview warns | `verify-build-identity` |
| The release gate itself — a skipped browser test fails under CI | `verify-ci-gate` |
| Security headers — every CSP directive, HSTS, COOP, and the app fitting them | `verify-security-headers` |
| The CSP proven live — eight pages served under the real header, no violations | `render-csp` |
| One URL scheme allowlist — board, emails, /api/go redirect, ingest, rel=noopener | `render-safe-url` |
| RADAR_TOKEN reads and cannot operate; CRON_SECRET/admins can | `verify-token-privilege` |
| Source prefilter + feed-candidate hygiene | `render-prefilter` |
| Feed probe — a 200 with no feed says WHY, not just its status | `verify-feed-probe` |
| Trends leaderboard paging (all outlets/journalists reachable) | `render-leaderboard-pages` |
| Trends export (Excel workbook, print page with charts) | `render-trends-export` |
| DB helpers (row-cap warnings) | `db-caps` |
| Classifier / de-dupe judgement rules (prompt invariants) | `verify-judgement-rules` |
| Guide page | `render-guide` |
| Pipeline health checks + daily push (`/api/alerts`) | `verify-health-checks` (backend), `render-health-tab` (browser) |
| Link previews & branding (OG/Twitter tags, favicon, PNG assets) | `render-og` |

`narr-fixture.mjs` is data (real production items, captured 2026-07-27 and
recaptured 2026-07-31 — 100 rows), not a test.

The narrative LLM pass is mocked in `narr-ai` — the sandbox has no
`ANTHROPIC_API_KEY`. That test pins the contract and every failure mode; the
grouping quality itself is verified in production.

Historical note: an early `smoke-task4` (weekly report endpoint) was dropped —
it predated the Bearer-only auth and Vodafone-only report lanes; its subject is
covered by `render-notoken` and `render-lanes-email-report`.

House rule: **one task = one commit**, and run `npm test` (or at least the
tests for the area you touched) before committing.
