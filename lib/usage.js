// Per-call Anthropic token accounting, so month-to-date spend is a GAUGE
// rather than a tripwire.
//
// WHY THIS EXISTS: nothing in PR Radar could answer "how much has this month
// cost so far?". The failure mode is silent and total — an account that hits its
// spend cap doesn't warn, it just starts refusing calls, and the first symptom
// is a morning brief full of `unclassified` items (classify.js parks an item it
// got no verdict for rather than guessing). By then the brief has already gone
// out degraded.
//
// The API returns a usage block on every response. Recording it costs one
// fire-and-forget insert and turns the cap from something discovered by hitting
// it into something watched on the way up.
//
// FAIL-SOFT AND OPTIONAL: needs migrations/2026-08-02-pr-usage.sql. Until that
// table exists every insert quietly fails and the rest of the pipeline is
// unaffected — recording spend must never be able to break a brief.

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Which price tier a stage bills at. Keyed by STAGE, not by model string: model
// ids come from env and change, but "the first-pass screen is the cheap tier"
// is a property of the pipeline's design. Every PR Radar stage currently runs
// on the cheap model; the map exists so adding one premium stage later prices
// it correctly instead of silently under-reporting the month.
const TIER = {
  classify: 'cheap',      // lib/classify.js — the first-pass screen
  dedupe: 'cheap',        // lib/dedupe-semantic.js — same-event backstop
  narrative: 'cheap',     // lib/narratives.js — Trends stage-2 grouping
  author: 'cheap',        // lib/author.js — byline fallback
  geo: 'cheap',           // lib/geo.js — the dormant GEO audit
};

// $ per MILLION tokens. Deliberately env-overridable and deliberately
// approximate: published rates change, and this is a budget gauge, not an
// invoice. Treat the number on the page as "roughly", and reconcile against the
// provider console before making a decision that depends on the exact figure.
const price = (tier, dir) => {
  const env = Number(process.env[`PRICE_${tier.toUpperCase()}_${dir.toUpperCase()}`]);
  if (Number.isFinite(env) && env > 0) return env;
  if (tier === 'cheap') return dir === 'in' ? 1 : 5;
  return dir === 'in' ? 3 : 15;
};

/** Cost of one usage row, in USD.
 *  Cached input is billed differently from fresh input — cache WRITES cost more
 *  than normal input and cache READS cost far less. classify.js caches its
 *  system block on every batch, so ignoring the split would materially
 *  misstate the total. */
export function rowCostUsd(row) {
  const tier = TIER[row.stage] || 'premium';
  const inTok = (Number(row.input_tokens) || 0)
    + (Number(row.cache_create_tokens) || 0) * 1.25
    + (Number(row.cache_read_tokens) || 0) * 0.1;
  const outTok = Number(row.output_tokens) || 0;
  return (inTok * price(tier, 'in') + outTok * price(tier, 'out')) / 1e6;
}

/** Total USD across rows. */
export const totalCostUsd = (rows = []) => rows.reduce((s, r) => s + rowCostUsd(r), 0);

/** Record one API call's usage. Fire-and-forget: never awaited for correctness,
 *  never throws, and a missing table is silently fine. Call sites pass the raw
 *  Anthropic response body — the usage block is read off it here so no caller
 *  has to know the shape. */
export async function recordUsage(stage, model, data) {
  const u = data?.usage;
  if (!u || !URL_BASE || !KEY) return false;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/pr_usage`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        stage,
        model: typeof model === 'string' ? model.slice(0, 80) : null,
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_create_tokens: u.cache_creation_input_tokens || 0,
        cache_read_tokens: u.cache_read_input_tokens || 0,
      }),
    });
    return res.ok;
  } catch {
    return false;   // usage accounting must never break the caller
  }
}

/** Prompt-cache reuse over `hours`, across the stages that actually cache.
 *
 *  Caching is the main reason the first-pass screen is cheap: a cache READ
 *  costs a fraction of fresh input, while a cache WRITE costs more. If a prompt
 *  edit breaks reuse — a timestamp in the system block, house knowledge that
 *  now changes every run — every write is paid for and never amortised, and the
 *  bill rises with no other symptom anywhere.
 *
 *  Returns null when there is too little traffic to judge: a single-batch run
 *  legitimately writes the cache and never reads it, and calling that a
 *  regression would make the check noise.
 */
export function cacheEfficiency(rows = [], { hours = 24, minCalls = 5 } = {}) {
  const since = Date.now() - hours * 36e5;
  let read = 0, write = 0, calls = 0;
  // Is caching STILL being requested, or is a poor ratio just history? The
  // window is 24h, so rows from before a fix keep the ratio pinned for a whole
  // day after the behaviour changed — the page would go on warning about
  // something already dealt with, which is how a check loses its reader.
  let latestAt = -Infinity, latestCached = false;
  for (const r of rows) {
    if (TIER[r.stage] === undefined) continue;
    const at = Date.parse(r.created_at ?? '');
    if (Number.isFinite(at) && at < since) continue;
    const w = Number(r.cache_create_tokens) || 0;
    const d = Number(r.cache_read_tokens) || 0;
    if (Number.isFinite(at) && at > latestAt) { latestAt = at; latestCached = !!(w || d); }
    if (!w && !d) continue;            // a stage/call that never caches
    write += w; read += d; calls++;
  }
  if (calls < minCalls || read + write === 0) return null;
  // `singles` = calls that WROTE the cache and had nothing read it back. When
  // every run is one batch, classify.js deliberately does not request caching at
  // all (there is no second call to collect on the write), so those calls carry
  // no cache tokens and never reach this function. A 0% ratio here therefore
  // means caching WAS asked for and still went unused — a real regression,
  // not the single-batch shape.
  return {
    calls, read, write, ratio: read / (read + write),
    // false → the most recent call did not touch the cache at all, so whatever
    // the ratio says is about calls that have already stopped happening.
    stillCaching: latestCached,
  };
}
