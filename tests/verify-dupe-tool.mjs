// Admin → Tools → "Find duplicates": surface cards that are really one story,
// and fold one into the other on request.
//
// Ingest merges what it is SURE about (see verify-crossrun-merge). What reaches
// this tool is the residue: pairs whose wording overlaps too little for the
// automatic bars but which a person can see are the same event — the band the
// melody-plagiarism pair sat in. The judgement stays human; the tool only finds
// and applies.
import assert from 'node:assert';
import { findDuplicateCandidates } from '../lib/dedupe.js';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const ITEMS = [
  // A real duplicate: same award, English and Arabic, hours apart.
  { id: 10, brand: 'Vodafone', source: 'Tech Wire', headline: 'Vodafone Egypt earns umlaut Best In Test award for network quality',
    summary: 'Vodafone Egypt wins the umlaut Best In Test award for network quality.', published_at: day(3) },
  { id: 11, brand: 'Vodafone', source: 'Al Mal', headline: 'Vodafone Egypt wins umlaut Best In Test network quality award',
    summary: 'Vodafone Egypt wins the umlaut Best In Test award for its network quality.', published_at: day(3) },
  // Same brand, same week, genuinely different stories — must NOT be offered.
  { id: 12, brand: 'Vodafone', source: 'Youm7', headline: 'Vodafone Cash outage disrupts transfers nationwide',
    summary: 'A Vodafone Cash outage disrupted transfers across the country.', published_at: day(2) },
  // Same event but months apart — outside the comparison window.
  { id: 13, brand: 'Vodafone', source: 'Old Paper', headline: 'Vodafone Egypt earns umlaut Best In Test award for network quality',
    summary: 'Vodafone Egypt wins the umlaut Best In Test award for network quality.', published_at: day(60) },
];

// ── the finder itself ──
const pairs = findDuplicateCandidates(ITEMS, { min: 0.3 });
const ids = pairs.map((p) => [p.keep.id, p.drop.id].sort((a, b) => a - b).join('+'));
assert.ok(ids.includes('10+11'), `the duplicated award is offered (got ${JSON.stringify(ids)})`);
assert.ok(!ids.some((p) => p.includes('12')), 'a genuinely different story is never offered');
assert.ok(!ids.includes('10+13'), 'a match outside the comparison window is not offered');
const award = pairs.find((p) => [p.keep.id, p.drop.id].includes(11));
assert.strictEqual(award.keep.id, 10, 'the OLDER card is the one kept — the board already links to it');
assert.ok(award.score >= 0.3 && award.band, 'each pair carries a score and a band for the reader to judge');

// ── the endpoint + the merge ──
let patched = null;
const instanceWrites = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });
  // PATCH first — the merge hides the duplicate by patching the same id it read.
  if (u.includes('/rest/v1/pr_items') && m === 'PATCH') { patched = { url: u, body: JSON.parse(opts.body) }; return ok(''); }
  if (u.includes('/rest/v1/pr_items') && m === 'GET' && u.includes('is_relevant=is.true')) return ok(JSON.stringify(ITEMS));
  if (u.includes('/rest/v1/pr_items') && u.includes('id=eq.11')) return ok(JSON.stringify([{ id: 11, source: 'Al Mal', author: 'Sara', url: 'https://almal/1', published_at: day(3) }]));
  if (u.includes('/rest/v1/pr_items') && u.includes('id=eq.10')) return ok(JSON.stringify([{ id: 10 }]));
  if (u.includes('/rest/v1/pr_instances') && m === 'POST') { instanceWrites.push(...JSON.parse(opts.body)); return ok(''); }
  if (u.includes('/rest/v1/pr_instances')) return ok('[]');
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const call = async (req) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
  await handler({ headers: { authorization: 'Bearer admin' }, ...req }, res);
  return { code, body };
};

// Scanning is read-only — it must not touch a single row.
const scan = await call({ method: 'GET', query: { view: 'find-dupes', days: '30' } });
assert.strictEqual(scan.code, 200, 'scan returns 200');
assert.ok(scan.body.pairs.length >= 1, 'the endpoint returns candidate pairs');
assert.strictEqual(patched, null, 'scanning changes nothing');
assert.strictEqual(instanceWrites.length, 0, 'scanning writes nothing');

// Merging moves the coverage and hides the duplicate everywhere.
const merge = await call({ method: 'POST', query: { resource: 'merge-dupe' }, body: { keep: 10, drop: 11 } });
assert.strictEqual(merge.code, 200, `merge returns 200 (got ${JSON.stringify(merge.body)})`);
assert.strictEqual(merge.body.outletsMoved, 1, 'the duplicate\'s outlet is reported as moved');
const moved = instanceWrites.find((r) => r.item_id === 10);
assert.ok(moved, 'coverage is written against the card we keep');
assert.strictEqual(moved.url, 'https://almal/1', 'the duplicate\'s URL is carried over');
assert.strictEqual(moved.author, 'Sara', 'the duplicate\'s byline is carried over — often the only one');
// is_relevant, NOT team_share: a team_share hide leaves the row counting in
// Trends, so the story would still be double-counted in the analytics.
assert.ok(patched && /id=eq\.11/.test(patched.url), 'the DUPLICATE is the row patched, never the card we keep');
assert.deepStrictEqual(patched.body, { is_relevant: false }, 'the duplicate is hidden everywhere, not just on the board');

// Nonsense input is refused rather than half-applied.
for (const bad of [{ keep: 10, drop: 10 }, { keep: 10 }, { keep: 'x', drop: 'y' }]) {
  const r = await call({ method: 'POST', query: { resource: 'merge-dupe' }, body: bad });
  assert.strictEqual(r.code, 400, `refuses ${JSON.stringify(bad)}`);
}

console.log('DUPE-TOOL OK — finder offers the real duplicate (keeping the older card) and never the distinct story or an out-of-window match; scan is read-only; merge moves outlet + byline onto the kept card and hides the duplicate via is_relevant; bad input is refused');
