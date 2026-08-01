// Stored-author backfill: the DAILY full run fills recent, still-authorless
// board items (RSS byline OR the resolve→fetch→AI path) and writes the byline
// back; urgent/dry runs never touch it. Bounded + fail-soft.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'ak';
process.env.BOARD_URL = 'https://pr.example/';
// RADAR_TO intentionally unset → no bulletin recipients → no email side effects.

// Two recent RELEVANT items with author = NULL (as the urgent poll leaves them):
//  100 — no RSS byline; article has a plain-text byline → resolved via AI fallback.
//  101 — an instance carries an RSS byline → filled without any fetch.
const authorless = [
  { id: 100, url: 'https://youm7.example/story-a', resolved_url: null, source: 'Youm7', importance: 4 },
  { id: 101, url: 'https://masrawy.example/story-b', resolved_url: null, source: 'Masrawy', importance: 3 },
  { id: 102, url: 'https://news.google.com/rss/articles/GWRAP', resolved_url: null, source: 'GNews', importance: 2 },   // wrapper won't decode → unresolved
  { id: 103, url: 'https://nobyline.example/c', resolved_url: null, source: 'NoByline', importance: 2 },              // fetches OK, no byline
  { id: 104, url: 'https://blocked403.example/d', resolved_url: null, source: 'Blocked', importance: 2 },            // fetch 403 → fetchFailed
];
const instances = {
  100: [{ item_id: 100, outlet: 'Youm7', author: null, url: 'https://youm7.example/story-a', published_at: null }],
  101: [{ item_id: 101, outlet: 'Masrawy', author: 'Sara Fahmy', url: 'https://masrawy.example/story-b', published_at: null }],
  102: [{ item_id: 102, outlet: 'GNews', author: null, url: 'https://news.google.com/rss/articles/GWRAP', published_at: null }],
  103: [{ item_id: 103, outlet: 'NoByline', author: null, url: 'https://nobyline.example/c', published_at: null }],
  104: [{ item_id: 104, outlet: 'Blocked', author: null, url: 'https://blocked403.example/d', published_at: null }],
};

let authorlessQueried = false;
let aiCalls = 0, emails = 0, feedFetches = 0, classifyCalls = 0;
const authorPatches = [];   // { id, body }
const filledIds = new Set(); // ids whose author has been written — drop from the authorless set
const RSS_EMPTY = '<?xml version="1.0"?><rss><channel></channel></rss>';
const ARTICLE_100 = '<html><body><h1>Fintech</h1><p>Finteck Gate: Riham Ali</p><p>Cairo — the company issued a long detailed statement on Sunday describing the incident and the remediation steps under way.</p></body></html>';

globalThis.fetch = async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET';
  const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });

  if (u.includes('news.google.com/rss/search') || /\/feed|technotime|dailynews|alborsa|egyptindependent|madamasr|amwalalghad/.test(u)) { feedFetches++; return ok(RSS_EMPTY); }

  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    if (/AUTHOR BYLINE/.test(body.system)) { aiCalls++; return ok(JSON.stringify({ content: [{ type: 'text', text: '{"author":"Riham Ali"}' }] })); }
    classifyCalls++; return ok(JSON.stringify({ content: [{ type: 'text', text: '[]' }] })); // classify
  }

  if (u.includes('/rest/v1/pr_items')) {
    if (m === 'GET' && u.includes('author=is.null')) { authorlessQueried = true; return ok(JSON.stringify(authorless.filter((i) => !filledIds.has(i.id)))); }
    if (m === 'GET' && /select=id(,|%2C)?hash|select=hash/.test(u)) return ok('[]');   // existingHashes / recentStories
    if (m === 'GET') return ok('[]');                                          // recentItems / itemsForStats
    if (m === 'PATCH') {
      const id = Number((u.match(/id=eq\.(\d+)/) || [])[1]);
      const bodyObj = JSON.parse(opts.body);
      if ('author' in bodyObj) { authorPatches.push({ id, body: bodyObj }); filledIds.add(id); }
      return { ok: true, status: 204, text: async () => '' };
    }
    if (m === 'POST') return ok('[]');
  }
  if (u.includes('/rest/v1/pr_instances')) {
    const ids = decodeURIComponent((u.match(/item_id=in\.\(([^)]*)\)/) || [])[1] || '').split(',').map(Number);
    return ok(JSON.stringify(ids.flatMap((id) => instances[id] || [])));
  }
  if (u.includes('/rest/v1/pr_feed_health')) return ok(m === 'POST' ? '' : '[]');
  if (u.includes('/rest/v1/pr_state')) return ok(m === 'GET' ? '[]' : '');
  if (u.includes('/rest/v1/pr_subscribers')) return ok('[]');
  if (u.includes('api.resend.com')) { emails++; return ok('{"id":"x"}'); }
  if (u.includes('/rest/v1/')) return ok('[]');

  // article page fetches (fetchAuthorProbe)
  if (u.includes('blocked403.example')) return { ok: false, status: 403, text: async () => 'blocked', json: async () => ({}) };
  if (u.includes('youm7.example')) return ok(ARTICLE_100);
  return ok('<html></html>');
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/radar.js');
const run = async (query) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {}, send() {} };
  await handler({ query, headers: { authorization: 'Bearer tok' } }, res);
  return { code, body };
};

// ── daily full run: fills both authorless items ──
filledIds.clear();
authorlessQueried = false; authorPatches.length = 0; aiCalls = 0;
const daily = await run({});
assert.strictEqual(daily.code, 200, 'daily run 200');
assert.ok(authorlessQueried, 'daily run queried for authorless items');
assert.strictEqual(daily.body.authorsBackfilled, 2, `filled both, got ${daily.body.authorsBackfilled}`);
const p100 = authorPatches.find((p) => p.id === 100);
const p101 = authorPatches.find((p) => p.id === 101);
assert.ok(p100 && p100.body.author === 'Riham Ali', 'item 100 filled via resolve→fetch→AI fallback');
assert.ok(p100.body.resolved_url === 'https://youm7.example/story-a', 'item 100 also cached its resolved publisher URL');
assert.ok(p101 && p101.body.author === 'Sara Fahmy', 'item 101 filled from the RSS byline (no fetch)');
assert.strictEqual(aiCalls, 1, 'exactly one AI byline call (item 100 only; 101 used the RSS byline)');

// ── urgent poll: NEVER runs the backfill ──
authorlessQueried = false; authorPatches.length = 0;
const urgent = await run({ urgentOnly: '1' });
assert.strictEqual(urgent.code, 200, 'urgent run 200');
assert.ok(!authorlessQueried, 'urgent poll did NOT query authorless items');
assert.strictEqual(authorPatches.length, 0, 'urgent poll wrote no authors');

// ── dry run: NEVER writes ──
authorlessQueried = false; authorPatches.length = 0;
const dry = await run({ dry: '1' });
assert.strictEqual(dry.code, 200, 'dry run 200');
assert.strictEqual(authorPatches.length, 0, 'dry run wrote no authors');
assert.strictEqual(dry.body.authorsBackfilled, 0, 'dry run reports 0 backfilled');

// ── emails: none in this harness (RADAR_TO unset) — proves backfill is independent of delivery ──
assert.strictEqual(emails, 0, 'no emails sent (no recipients configured)');

// ── on-demand ?backfillAuthors=1 endpoint: sweeps authorless items with NO ingest ──
filledIds.clear();
authorlessQueried = false; authorPatches.length = 0; aiCalls = 0;
feedFetches = 0; classifyCalls = 0; emails = 0;
const sweep = await run({ backfillAuthors: '1', days: '3', limit: '20' });
assert.strictEqual(sweep.code, 200, 'sweep returns 200');
assert.strictEqual(sweep.body.backfillAuthors, true, 'sweep response is flagged');
assert.strictEqual(sweep.body.scanned, 5, 'sweep scanned all 5 authorless items');
assert.strictEqual(sweep.body.filled, 2, 'sweep filled the 2 fillable');
assert.strictEqual(sweep.body.unresolved, 1, 'diagnosis: 1 item had an unresolvable Google-News link');
assert.strictEqual(sweep.body.fetchFailed, 1, 'diagnosis: 1 item fetch-failed (403/blocked)');
assert.strictEqual(sweep.body.noByline, 1, 'diagnosis: 1 item fetched OK but had no byline');
assert.strictEqual(sweep.body.writeFailed, 0, 'diagnosis: 0 write failures');
assert.strictEqual(sweep.body.aiEnabled, true, 'AI byline fallback reported enabled (key set)');
assert.strictEqual(sweep.body.remaining, 3, 'the 3 unfillable items remain');
assert.strictEqual(feedFetches, 0, 'sweep fetched NO feeds (skips the ingest pipeline entirely)');
assert.strictEqual(classifyCalls, 0, 'sweep ran NO classify calls');
assert.strictEqual(emails, 0, 'sweep sent NO emails');
assert.strictEqual(authorPatches.length, 2, 'sweep wrote only the 2 fillable authors');
assert.strictEqual(aiCalls, 1, 'one AI byline call (item 100 only)');

// a bounded ?limit is honoured
filledIds.clear();
const sweep1 = await run({ backfillAuthors: '1', limit: '1' });
assert.ok(sweep1.body.limit === 1, 'limit echoed');

console.log('AUTHOR-BACKFILL OK — daily run fills authorless items (RSS byline + AI-fallback fetch, resolved_url cached); urgent/dry never query or write; ?backfillAuthors=1 sweeps with NO feeds/classify/emails and reports scanned/filled/remaining; bounded & fail-soft');
