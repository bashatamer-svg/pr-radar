# PR Radar

A daily **brand & reputation** monitor for the Vodafone Egypt PR / communications
team. It scans Egyptian news for the four mobile brands — **Vodafone, Orange, WE,
e&** — classifies each story's **sentiment** from Vodafone's standpoint, and
delivers a sentiment-first bulletin + board that marks **who published it
(author)**, **where**, and **every outlet that ran it** — flagging anything
negative.

It's a standalone sibling of the Regulatory Radar: the same proven pipeline shape
(Vercel serverless + Supabase + Resend, ESM, no build step), retargeted from
regulatory materiality to PR sentiment.

## Pipeline (`api/radar.js`)
1. **Fetch** every feed in `lib/sources.js` — Google-News brand queries (EN + AR
   for each of the four brands) + a market sweep, plus verified Egyptian outlet
   RSS feeds — in parallel, with per-feed health logged to `pr_feed_health`.
2. **Freshness** — drop items older than 48h.
3. **Dedupe** — SHA-256 of the normalised headline, then fuzzy + summary +
   semantic passes. Cluster members are **kept as coverage instances**
   (outlet · author · url · date), not discarded — for a PR team, coverage
   spread *is* the signal.
4. **Classify** (`lib/classify.js`, Haiku) — brand, **sentiment**
   (negative / neutral / positive), severity 1-5, category, a one-line summary,
   and a 3-line `pr_angle` (Read / Audience / Action). A negative Vodafone story
   is never rated below severity 3.
5. **Resolve → author → instances** — for shown items, decode the Google-News
   wrapper to the real publisher URL (`lib/resolve.js`), fetch the article and
   extract the byline (`lib/author.js`), cache the clean URL onto the card, and
   write every outlet to `pr_instances`.
6. **Deliver** — a daily email (`lib/email.js`) and the board
   (`public/index.html`), both negatives-first and highlighted. Severity-5 items
   also fire an immediate URGENT email.

## Shared Supabase, zero impact on the Regulatory Radar
This app can run in the **same Supabase project** as the Regulatory Radar. Every
table is prefixed `pr_` (see `schema.sql`) and the code only ever reads/writes
`pr_*` — it never references `radar_*`. Applying `schema.sql` to the project only
**adds** the pr_* tables; the regulatory data is untouched.

> Caveat: a shared project means the two apps share the project's service-role
> key and free-tier quotas. Only a *separate* project makes cross-access
> physically impossible.

## Endpoints
- `GET /api/radar` — the pipeline (Vercel Cron, daily). `?dry=1` skips DB + email;
  `?to=<email>` sends the real brief to one address only; `?urgentOnly=1` fires
  only severity-5 alerts. Auth: `Bearer $CRON_SECRET` or `$RADAR_TOKEN` (or `?t=`).
- `GET /api/items?t=…` — board data; `PATCH` writes item feedback.
- `GET /api/go?id=…` — share-redirect that decodes the stored Google-News wrapper
  to the real article (cached on first use).

## Deploy
1. Set env vars from `.env.example` in Vercel.
2. Apply `schema.sql` to your Supabase project (adds pr_* tables only).
3. Deploy to Vercel — the daily cron is declared in `vercel.json`.

## Smoke-test (no side effects)
```
curl -H "Authorization: Bearer $RADAR_TOKEN" "https://YOUR.vercel.app/api/radar?dry=1"
```
Response includes `scanned`, `candidates`, `emailed`, `brokenFeeds`. If `scanned`
is near zero, the feeds are the problem, not the code.

Prove the email end-to-end to a single address:
```
curl -H "Authorization: Bearer $RADAR_TOKEN" "https://YOUR.vercel.app/api/radar?to=you@example.com"
```

View the board: `https://YOUR.vercel.app/?t=$RADAR_TOKEN`

## Model & cost
The classifier and semantic-dedup passes use `CLASSIFIER_MODEL` (default Haiku) —
cheap, headline-only. There are no Sonnet passes in this version. Use a
**separate** `ANTHROPIC_API_KEY` so PR spend stays off the Regulatory Radar's
budget.

> Live Google-News decoding only works where Google is reachable (Vercel), not in
> a local sandbox — validate the author backfill on a preview deploy.
