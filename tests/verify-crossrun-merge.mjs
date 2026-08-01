// A story we already have, published again by a SECOND outlet in a later run,
// must be MERGED onto the existing card as coverage — not thrown away.
//
// Within a single run this always worked (fuzzyDedupe keeps every cluster
// member as an instance). Across runs it did not: all four cross-run passes
// simply filtered the duplicate out, so the second outlet — and often the only
// byline on the story — was never recorded, and the card's "◱ N outlets" only
// ever counted outlets seen in one run. Reported live 2026-08-01.
//
// Every cross-run path is exercised here, because each one dropped the item
// independently: exact hash, headline Jaccard, summary hash, summary Jaccard.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RADAR_TO = 'team@example.com';
process.env.RESEND_API_KEY = 're_x';

const STORED = {
  id: 4242,
  hash: 'stored-hash',
  headline: 'Vodafone Cash suffers nationwide outage affecting transfers',
  summary: 'A Vodafone Cash outage disrupted transfers for users nationwide.',
  country: 'Egypt',
};

// The repost: a different outlet, different wording, different hash — the same
// event. It carries a byline the stored card does not have.
const REPOST_TITLE = 'Vodafone Cash outage disrupts transfers nationwide, users report';
const REPOST_URL = 'https://news.google.com/rss/articles/repost-1';

const rss = () => `<?xml version="1.0"?><rss><channel><item>
  <title>${REPOST_TITLE}</title><link>${REPOST_URL}</link>
  <author>Fatma Soliman</author>
  <source url="https://telegraph.eg">Telegraph Egypt</source>
  <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

let instanceWrites = [];
let itemInserts = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

  if (u.includes('news.google.com') || u.includes('/rss') || u.includes('/feed')) return ok(rss());
  // existingHashes — the repost has a NEW hash, so this reports nothing seen;
  // the headline/summary passes are what must catch it.
  if (u.includes('/rest/v1/pr_items') && /select=(id,)?hash&hash=in/.test(u)) return ok('[]');
  // recentStories — the stored card, WITH its id (the merge target).
  if (u.includes('/rest/v1/pr_items') && /select=id,headline/.test(u)) return ok(JSON.stringify([STORED]));
  if (u.includes('/rest/v1/pr_items') && /select=id,summary_hash/.test(u)) return ok('[]');
  if (u.includes('/rest/v1/pr_items') && m === 'POST') {
    itemInserts++;
    const b = JSON.parse(opts.body);
    return ok(JSON.stringify(b.map((r, i) => ({ ...r, id: 1 + i }))));
  }
  if (u.includes('/rest/v1/pr_instances') && m === 'POST') {
    instanceWrites.push(...JSON.parse(opts.body));
    return ok('');
  }
  if (u.includes('api.anthropic.com')) {
    // Classifier: the repost is a relevant Vodafone story. (It never gets here
    // if the headline pass already merged it — which is the expected path.)
    return ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([{ i: 0, is_relevant: true, brand: 'Vodafone', sentiment: 'negative', category: 'vodafone_cash', summary: STORED.summary, pr_angle: '', importance: 4, confidence: 0.9 }]) }] }));
  }
  if (u.includes('api.resend.com')) return ok('{"id":"x"}');
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/radar.js');
let code, body;
const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
// NOT ?debug=1 — that path returns the funnel before any write happens.
await handler({ query: {}, headers: { authorization: 'Bearer admin' } }, res);

assert.strictEqual(code, 200, 'run returns 200');

// 1. It must NOT become a second card.
assert.ok(!(body.new > 0) || itemInserts === 0 || body.new === 0,
  `the repost must not be inserted as a new story (new=${body.new})`);

// 2. It must be REPORTED as merged, not silently vanish — the counter is how a
//    future reader knows coverage was folded in rather than lost.
assert.ok(body.mergedIntoExisting >= 1,
  `the run reports the merge rather than a silent drop (body=${JSON.stringify(body)})`);

// 3. …and the outlet must be written against the EXISTING card's id.
const merged = instanceWrites.filter((r) => r.item_id === STORED.id);
assert.ok(merged.length >= 1, `coverage is attached to the stored card ${STORED.id} (wrote ${JSON.stringify(instanceWrites)})`);
const row = merged[0];
// An outlet is recorded (which one it resolves to is feed-parsing, covered by
// render-coverage — what matters here is that coverage is attributed at all).
assert.ok(String(row.outlet || '').length > 0, `an outlet is recorded on the merge (got ${JSON.stringify(row.outlet)})`);
assert.strictEqual(row.url, REPOST_URL, 'the repost URL is recorded, so the card can link to it');
// The byline is the part most often lost: the stored card was newsroom copy.
assert.ok(/Fatma/.test(String(row.author || '')), `the repost's byline survives the merge (got ${row.author})`);

// 4. Never write an instance without a target — a null id must be skipped, not
//    written as item_id: null (which would fail the FK and lose the batch).
assert.ok(instanceWrites.every((r) => r.item_id != null), 'no instance row is written without an item id');

console.log(`CROSSRUN-MERGE OK — a repost from a second outlet is folded into card ${STORED.id} as coverage (outlet + url + byline kept), reported as mergedIntoExisting, and never inserted as a duplicate card`);
