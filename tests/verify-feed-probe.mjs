// Admin → Tools → "Probe feeds" — the diagnosis, not just the status code.
//
// The 3 Aug run promoted 1 of 31 candidates. Most of the rest 404'd, which is a
// dead end — but eight URLs answered 200/202 and reported nothing, and the
// panel printed a bare "tried: 200 · 200" for them. That reads identically to a
// dead host while meaning the opposite: the server is alive and serving
// something, so the URL SHAPE is wrong and there may be a real feed to find.
// Without a reason the only move left is to guess another suffix, which is how
// the list got picked over in the first place.
//
// Re-probing with the reason attached settled all eight in one click: seven
// were HTML pages (no feed there, retired) and one — Youm7 — was a VALID RSS
// document with no items, i.e. the right endpoint and the wrong section id.
// That single distinction is the whole value of this test.
//
// Pinned here: each 200-with-no-items failure names what actually came back.
import assert from 'node:assert';

process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><item>
  <title>Vodafone Egypt raises data prices</title><link>https://x/1</link>
  <dc:creator>Mona Salah</dc:creator></item></channel></rss>`;

// One body per candidate URL. Everything not listed here 404s.
let BODIES = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]' };
  const b = BODIES[u];
  if (!b) return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  return {
    ok: true, status: b.status || 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (b.type || 'text/html') : '') },
    text: async () => b.body,
  };
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const probe = async (only) => {
  let out;
  const res = { status: () => res, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({ method: 'GET', query: { view: 'probe-feeds', only }, headers: { authorization: 'Bearer admin' } }, res);
  return out;
};

const { FEED_CANDIDATES } = await import(new URL('..', import.meta.url).pathname + '/lib/feed-candidates.js');
const first = (id) => FEED_CANDIDATES.find((c) => c.id === id).urls[0];

// ── a real feed is reported with its item and byline counts ──
{
  BODIES = { [first('youm7')]: { body: FEED, type: 'application/rss+xml' } };
  const d = await probe('youm7');
  const row = d.rows[0];
  assert.strictEqual(row.working, true, 'a valid feed is reported working');
  assert.strictEqual(row.items, 1, 'with its item count');
  assert.strictEqual(row.bylines, 1, 'and how many carry a byline — the reason to prefer a direct feed');
  assert.match(row.sample, /Vodafone Egypt raises/, 'and a sample headline to eyeball the language');
}

// ── 200 + an HTML page: the outlet has no feed AT THIS PATH ──
// The commonest real answer — seven of the eight were this (Al Shorouk, MCIT,
// the Orange newsroom, Amwal Al Ghad, Enterprise, CNN Business Arabic, Zawya),
// and knowing it is what let them be retired rather than re-probed forever.
{
  BODIES = { [first('youm7')]: { body: '<!DOCTYPE html><html><body>news</body></html>', type: 'text/html' } };
  const d = await probe('youm7');
  const a = d.rows[0].attempts[0];
  assert.strictEqual(a.ok, false, 'an HTML page is not a feed');
  assert.strictEqual(a.status, 200, 'the status is still reported');
  assert.strictEqual(a.note, 'HTML page, not a feed', `the REASON is reported (got "${a.note}")`);
  assert.strictEqual(a.type, 'text/html', 'along with what the server said it was sending');
}

// ── 200 + valid XML that simply is not RSS/Atom ──
{
  BODIES = { [first('youm7')]: { body: '<?xml version="1.0"?><sitemapindex><sitemap/></sitemapindex>', type: 'application/xml' } };
  const d = await probe('youm7');
  assert.strictEqual(d.rows[0].attempts[0].note, 'XML, root <sitemapindex>',
    'a non-feed XML document names its root, so the next guess is informed');
}

// ── 200 + a real but EMPTY feed: the URL is right, the outlet is quiet ──
// Completely different from the above, and the difference decides whether the
// URL is worth keeping.
{
  BODIES = { [first('youm7')]: { body: '<?xml version="1.0"?><rss><channel></channel></rss>', type: 'application/rss+xml' } };
  const d = await probe('youm7');
  assert.strictEqual(d.rows[0].attempts[0].note, 'feed with 0 items', 'an empty feed says so');
}

// ── 200 + nothing at all ──
{
  BODIES = { [first('youm7')]: { body: '', type: 'text/html' } };
  const d = await probe('youm7');
  assert.strictEqual(d.rows[0].attempts[0].note, 'empty body', 'an empty response says so');
}

// ── a 404 carries NO note: there is nothing to diagnose ──
// The note is the signal that a URL is worth another attempt; attaching one to
// a dead host would drown the six that matter in the twenty-four that don't.
{
  BODIES = {};
  const d = await probe('youm7');
  const a = d.rows[0].attempts[0];
  assert.strictEqual(a.status, 404, 'a missing feed is still a 404');
  assert.strictEqual(a.note, undefined, 'and carries no note');
}

console.log('FEED-PROBE OK — a working feed reports items + bylines + a sample; a 200 with no feed names WHY (HTML page / XML root / empty feed / empty body) instead of reading like a dead host, and a 404 stays noteless');
