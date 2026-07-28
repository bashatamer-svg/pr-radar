// Coverage diagnostic (?debug=1): returns a per-story funnel trace and writes /
// sends NOTHING (no pr_items insert, no pr_instances, no email, no author fetch).
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'ak';
process.env.BOARD_URL = 'https://pr.example/';

// Feeds return 3 distinct Vodafone-ish stories: one clearly on-board (relevant,
// importance 4), one classifier-dropped (Vodafone Qatar — not Egypt), one
// low-importance (importance 1). The classifier mock keys off the headline.
const STORIES = [
  'Vodafone Egypt Cash nationwide outage hits transfers',   // relevant, imp 4 → ON BOARD
  'Vodafone Qatar board reshuffle announced',               // not relevant → dropped w/ reason
  'Vodafone Egypt minor app tweak released',                // relevant but imp 1 → below threshold
];
const verdictFor = (headline, i) => {
  if (/Qatar/i.test(headline)) return { i, is_relevant: false, brand: null, sentiment: null, country: 'Egypt', category: 'other', summary: 'qatar', pr_angle: '', importance: 1, confidence: 0.9, deadline: null, reason: 'Vodafone Qatar, not Egypt' };
  if (/minor app tweak/i.test(headline)) return { i, is_relevant: true, brand: 'Vodafone', sentiment: 'neutral', country: 'Egypt', category: 'corporate', summary: 'tweak', pr_angle: 'x', importance: 1, confidence: 0.7, deadline: null, reason: null };
  return { i, is_relevant: true, brand: 'Vodafone', sentiment: 'negative', country: 'Egypt', category: 'vodafone_cash', summary: 'outage', pr_angle: 'x', importance: 4, confidence: 0.9, deadline: null, reason: null };
};

let inserts = 0, instanceWrites = 0, emails = 0, authorFetches = 0;
let lastInsertBody = null;
const RSS = (titles) => `<?xml version="1.0"?><rss><channel>${titles.map((t) => `<item><title>${t}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(t).slice(0, 10)}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

globalThis.fetch = async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET';
  const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
  if (u.includes('news.google.com/rss/search')) return ok(RSS(STORIES));
  if (u.includes('/feed') || u.includes('technotime') || u.includes('dailynews') || u.includes('alborsa') || u.includes('egyptindependent') || u.includes('madamasr') || u.includes('amwalalghad')) return ok(RSS([]));
  if (u.includes('api.anthropic.com')) {
    // classify: parse the numbered headlines out of the user message, verdict each.
    const body = JSON.parse(opts.body);
    const content = body.messages[0].content;
    const verdicts = [];
    for (const line of content.split('\n')) {
      const mm = line.match(/^(\d+)\.\s+\[[^\]]*\]\s+(.*)$/);
      if (mm) verdicts.push(verdictFor(mm[2], Number(mm[1])));
    }
    return ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(verdicts) }] }));
  }
  if (u.includes('/rest/v1/pr_items') && u.includes('select=hash') && u.includes('order=')) return ok('[]'); // recentStories/other
  if (u.includes('/rest/v1/pr_items') && u.includes('select=hash&hash=in')) return ok('[]'); // existingHashes → nothing seen
  if (u.includes('/rest/v1/pr_items') && m === 'POST') { inserts++; const b = JSON.parse(opts.body); lastInsertBody = b; return ok(JSON.stringify(b.map((r, i) => ({ ...r, id: i + 1 })))); }
  if (u.includes('/rest/v1/pr_instances') && m === 'POST') { instanceWrites++; return ok(''); }
  if (u.includes('/rest/v1/pr_feed_health')) return ok(m === 'POST' ? '' : '[]');
  if (u.includes('api.resend.com')) { emails++; return ok('{"id":"x"}'); }
  if (u.includes('/rest/v1/')) return ok('[]');
  // any publisher article fetch = author backfill (must NOT happen in debug)
  authorFetches++;
  return ok('<html></html>');
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/radar.js');
const run = async (query) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {}, send() {} };
  await handler({ query, headers: { authorization: 'Bearer tok' } }, res);
  return { code, body };
};

// ── ?debug=1 ──
const dbg = await run({ debug: '1', brand: 'Vodafone', hours: '24' });
assert.strictEqual(dbg.code, 200, 'debug returns 200');
const b = dbg.body;
assert.ok(b.window && b.window.brand === 'Vodafone' && b.window.hours === 24, 'window echoes brand + hours');
assert.ok(Array.isArray(b.feeds) && b.feeds.length === 16, 'per-feed counts for all ALL_FEEDS');
assert.ok(b.funnel && typeof b.funnel.rawFetched === 'number' && typeof b.funnel.classifiedRelevant === 'number', 'funnel counts present');
assert.ok(Array.isArray(b.brandStories) && b.brandStories.length >= 3, `brand stories traced (got ${b.brandStories && b.brandStories.length})`);

const byHead = (frag) => b.brandStories.find((s) => new RegExp(frag, 'i').test(s.headline));
const onboard = byHead('nationwide outage');
const dropped = byHead('Qatar');
const lowimp = byHead('minor app tweak');
assert.ok(/ON BOARD/.test(onboard.disposition), `relevant imp4 → ON BOARD, got: ${onboard.disposition}`);
assert.ok(/not relevant/i.test(dropped.disposition) && /Qatar/i.test(dropped.disposition), `dropped carries the classifier reason, got: ${dropped.disposition}`);
assert.strictEqual(dropped.reason, 'Vodafone Qatar, not Egypt', 'reason field surfaced on the story');
assert.ok(/importance<2/.test(lowimp.disposition), `imp1 → below threshold, got: ${lowimp.disposition}`);

// missed = everything not ON BOARD
assert.ok(b.missed.every((s) => !/ON BOARD/.test(s.disposition)), 'missed excludes on-board stories');
assert.ok(b.missed.some((s) => /Qatar/i.test(s.headline)), 'the dropped Qatar story is in the gap list');

// ZERO side effects
assert.strictEqual(inserts, 0, 'debug wrote NO pr_items');
assert.strictEqual(instanceWrites, 0, 'debug wrote NO pr_instances');
assert.strictEqual(emails, 0, 'debug sent NO email');
assert.strictEqual(authorFetches, 0, 'debug did NO author backfill fetch');

// ── EDIT 5 check: a NORMAL (non-dry, non-debug) run strips `reason` before the
// pr_items insert, so the DB key set is untouched. ──
const norm = await run({});
assert.strictEqual(norm.code, 200, 'normal run returns 200');
assert.ok(inserts >= 1 && Array.isArray(lastInsertBody) && lastInsertBody.length, 'normal run inserted rows');
assert.ok(lastInsertBody.every((r) => !('reason' in r)), 'insert body carries NO reason key (stripped pre-insert)');
const keys = Object.keys(lastInsertBody[0]).sort();
assert.ok(keys.includes('hash') && keys.includes('is_relevant') && keys.includes('importance') && !keys.includes('reason'), 'pr_items key set is the normal columns, no reason');
// all inserted rows share one key set (PGRST102 safety preserved)
const sig = JSON.stringify(keys);
assert.ok(lastInsertBody.every((r) => JSON.stringify(Object.keys(r).sort()) === sig), 'uniform insert key set across rows');

console.log(`DEBUG OK — funnel trace returned (${b.brandStories.length} brand stories, ${b.missed.length} missed); reasons surfaced; 0 inserts / 0 instances / 0 emails / 0 author fetches on the debug run`);
console.log(`INSERT-STRIP OK — normal run insert body has no 'reason' key; uniform pr_items columns preserved [${keys.join(', ')}]`);
