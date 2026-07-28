# PR Radar test suite

Every behaviour shipped to production has a regression test here. All external
I/O is **mocked** (Supabase, Anthropic, Resend, article fetches, WhatsApp) — no
test touches the network or a real database, so the suite is safe anywhere.

## Run

```
npm install          # dev-only: playwright-core for the browser tests
npm test             # everything
npm test -- lanes    # only tests whose filename contains "lanes"
```

Browser tests drive headless Chromium. Set `CHROMIUM_PATH` to your Chromium
binary if the default sandbox path doesn't exist; without a browser those tests
are **skipped**, the unit suite still runs.

## What covers what

| Area | Tests |
|---|---|
| Ingest pipeline (feeds, dedup, classify, dry/urgent runs) | `smoke-task6`, `smoke-task1..3`, `smoke-task8..10`, `dedup-jaccard`, `render-debug` |
| Auth / RBAC / audit / password flows | `render-auth` (backend), `render-authui`, `render-adminui` (browser) |
| Author capture (cascade, AI fallback, ingest-time, backfill, sweep) | `verify-authors`, `verify-ai-author`, `render-poll-author`, `render-author-backfill` |
| Emails & webhooks (bulletin, urgent, report, no-token links) | `render-notoken`, `render-lanes-email-report`, `smoke-task2`, `render-whatsapp`, `send-guard` |
| Custom date-range reports (exec summary, appendix, Word/PDF export) | `smoke-report-range` (backend), `render-reports-page` (browser) |
| Surge detection (calendar + rolling windows) | `smoke-task7`, `render-surge-rolling` |
| Board UI (lanes, filters, deep links, auto-refresh, bylines, coverage) | `render-task11..15`, `render-lanes`, `render-deeplink`, `render-autorefresh`, `render-desk-byline`, `render-coverage`, `verify-bidi` |
| Trends narratives (clustering incl. real-data regression) | `render-narrative-cluster`, `narr-real` (+ `narr-fixture` — captured production rows), `render-narratives` |
| DB helpers (row-cap warnings) | `db-caps` |
| Guide page | `render-guide` |
| Link previews & branding (OG/Twitter tags, favicon, PNG assets) | `render-og` |

`narr-fixture.mjs` is data (real production items captured 2026-07-27), not a test.

Historical note: an early `smoke-task4` (weekly report endpoint) was dropped —
it predated the Bearer-only auth and Vodafone-only report lanes; its subject is
covered by `render-notoken` and `render-lanes-email-report`.

House rule: **one task = one commit**, and run `npm test` (or at least the
tests for the area you touched) before committing.
