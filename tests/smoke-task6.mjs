// Radar pipeline dry-run smoke (updated for Task 2).
//
// Task 2e folded the cross-operator MARKET SWEEP into the urgent poll, so
// BRAND_FEEDS is now the whole FEEDS list (8 brand queries + 2 market-sweep),
// excluding only the broad DIRECT_FEEDS outlet firehoses. Auth is Bearer-only
// (Task 18): the handler is driven with an Authorization header, not ?t=.
//
// Verifies end-to-end that the handler still boots and runs after the Task 2
// de-dup changes: urgent poll (fast early-return), full dry run with nothing
// new, and a full dry run where real candidates flow through the NEW cross-run
// headline filter + classify. Nothing is ever emailed on a dry/urgent run.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
// /api/radar is OPERATOR-gated (lib/auth.js): the read-only RADAR_TOKEN cannot
// drive the pipeline any more, so these drive it as the cron principal — which
// is what Vercel Cron actually sends. The refusal is pinned by
// verify-token-privilege.
process.env.CRON_SECRET = 'cron';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'ak';
process.env.BOARD_URL = 'https://pr.example/';

const { ALL_FEEDS, BRAND_FEEDS, FEEDS, DIRECT_FEEDS } = await import(new URL('..', import.meta.url).pathname + '/lib/sources.js');

// Sanity on the subset itself — the urgent poll now = brands + market sweep.
assert.strictEqual(BRAND_FEEDS.length, 10, 'BRAND_FEEDS = 8 brand queries + 2 market-sweep');
assert.strictEqual(BRAND_FEEDS.length, FEEDS.length, 'BRAND_FEEDS is the full FEEDS list');
assert.ok(BRAND_FEEDS.some((f) => f.brand === null), 'market sweep (brand:null) is now INCLUDED');
const brandUrls = new Set(BRAND_FEEDS.map((f) => f.url));
const marketUrls = FEEDS.filter((f) => !f.brand).map((f) => f.url);
const directUrls = DIRECT_FEEDS.map((f) => f.url);
assert.ok(marketUrls.length === 2 && marketUrls.every((u) => brandUrls.has(u)), 'market sweep included in the urgent subset');
assert.ok(directUrls.every((u) => !brandUrls.has(u)), 'direct outlet feeds still excluded');

// Track which feed URLs get fetched, whether any email send is attempted, and
// let a test toggle whether stored hashes are "already seen".
let fetchedFeedUrls = [];
let sendAttempts = 0;
let seenEchoesAll = true;   // true → existingHashes echoes every hash (nothing new)
const RSS = (titles) => `<?xml version="1.0"?><rss><channel>${titles.map((t) => `<item><title>${t}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(t).slice(0, 12)}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

// Two DISTINCT same-brand stories + a reworded near-duplicate of the first —
// the payload Task 2 is about (distinct/developing must survive as separate).
const STORIES = [
  'Vodafone Cash suffers nationwide outage affecting transfers',
  'Vodafone launches new eSIM data plans across Egypt',
  'Orange raises mobile bundle prices for the second time',
];

// Derived from the real source list: adding a feed must not silently
// reclassify its fetch as something else in this mock.
const { DIRECT_FEEDS: _DF } = await import(new URL('..', import.meta.url).pathname + '/lib/sources.js');
const DIRECT_URLS = _DF.map((f) => f.url);

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('news.google.com/rss/search')) { fetchedFeedUrls.push(u); return { ok: true, status: 200, text: async () => RSS(STORIES) }; }
  if (DIRECT_URLS.some((f) => u.startsWith(f))) {
    fetchedFeedUrls.push(u); return { ok: true, status: 200, text: async () => RSS(['Some outlet story about Telecom Egypt earnings']) };
  }
  if (u.includes('api.anthropic.com')) {
    // classify + semanticDedupe both hit /v1/messages. Return a valid, empty
    // JSON array → items fall through as unclassified (a safe, real code path).
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) };
  }
  if (u.includes('/rest/v1/pr_feed_health')) return { ok: true, text: async () => (opts && opts.method === 'POST' ? '' : '[]') };
  if (u.includes('/rest/v1/pr_items') && /select=(id,)?hash&hash=in/.test(u)) {
    if (!seenEchoesAll) return { ok: true, text: async () => '[]' };   // nothing seen → candidates flow
    const inList = decodeURIComponent((u.match(/hash=in\.\(([^)]*)\)/) || [])[1] || '');
    const hashes = inList ? inList.split(',') : [];
    // Echo an id with each hash, as the real query now does — that id is the
    // card a repost gets merged INTO.
    return { ok: true, text: async () => JSON.stringify(hashes.map((h, n) => ({ id: 900 + n, hash: h }))) };
  }
  if (u.includes('/rest/v1/pr_items') && /select=(id,)?headline/.test(u)) return { ok: true, text: async () => '[]' };
  if (u.includes('api.resend.com')) { sendAttempts++; return { ok: true, json: async () => ({ id: 'x' }) }; }
  if (u.includes('/rest/v1/')) return { ok: true, text: async () => '[]' };
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/radar.js');
const run = async (query) => {
  fetchedFeedUrls = [];
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {}, send() {} };
  await handler({ query, headers: { authorization: 'Bearer cron' } }, res);   // Bearer-only (Task 18)
  return { code, body, feeds: [...fetchedFeedUrls] };
};

// --- urgentOnly run: fetches brand + market feeds, fast early-return, no send ---
seenEchoesAll = true;
const urgent = await run({ urgentOnly: '1' });
assert.strictEqual(urgent.code, 200, 'urgent run returns 200');
const urgentFeeds = new Set(urgent.feeds);
assert.strictEqual(urgentFeeds.size, BRAND_FEEDS.length, `urgent fetched ${urgentFeeds.size} feeds, expected ${BRAND_FEEDS.length}`);
assert.ok([...brandUrls].every((u) => urgentFeeds.has(u)), 'all brand + market feeds fetched');
assert.ok(marketUrls.every((u) => urgentFeeds.has(u)), 'market sweep IS fetched on the urgent poll now');
assert.ok(directUrls.every((u) => !urgentFeeds.has(u)), 'outlet feeds NOT fetched on urgent poll');
assert.strictEqual(sendAttempts, 0, 'no email sent on urgent (early return)');
assert.ok(urgent.body.note === 'nothing new' || urgent.body.new === 0, 'fast early-return path');

// --- full dry run, nothing new: fetches ALL feeds, no send ---
seenEchoesAll = true;
const full = await run({ dry: '1' });
assert.strictEqual(full.code, 200, 'full dry run returns 200');
const fullFeeds = new Set(full.feeds);
assert.ok([...brandUrls].every((u) => fullFeeds.has(u)), 'full run fetches brand + market feeds');
assert.ok(directUrls.every((u) => fullFeeds.has(u)), 'full run fetches outlet feeds');
assert.strictEqual(full.body.feeds, ALL_FEEDS.length, 'full run reports ALL_FEEDS count');
assert.strictEqual(sendAttempts, 0, 'dry run sends nothing');

// --- full dry run, nothing seen: real candidates flow through the NEW cross-run
//     headline filter + classify (exercises the changed de-dup path). No send. ---
seenEchoesAll = false;
const flow = await run({ dry: '1' });
assert.strictEqual(flow.code, 200, 'candidates-flow dry run returns 200');
assert.strictEqual(sendAttempts, 0, 'still no send on a dry run with candidates');

console.log(`RADAR SMOKE OK — urgent fetched ${urgentFeeds.size} feeds (brands+market), full fetched ${fullFeeds.size}; candidates flow through classify; dry/urgent never email`);
