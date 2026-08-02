// Admin → Tools → "Re-classify parked stories".
//
// The Health check's hint has always said parked rows "can be re-run" — nothing
// could actually do it, so a burst sat at CRITICAL until it aged out of the 48h
// window. On 2 Aug that was 25 rows with ~18 hours left to run.
//
// What must hold: the re-run writes REAL verdicts onto the EXISTING rows (a card
// keeps its identity and its coverage), a story the model still won't answer for
// stays parked rather than being guessed at, and a rescued RELEVANT story is
// reported as such — a run that saves a real story must not read like one that
// swept up wire noise.
import assert from 'node:assert';

process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'sk-test';

const PARKED = [
  { id: 901, hash: 'h1', headline: 'Three bodies recovered after climbers go missing', url: 'https://x/1', source: 'Reuters', author: null, published_at: null },
  { id: 902, hash: 'h2', headline: 'Vodafone Egypt customers report billing errors', url: 'https://x/2', source: 'Youm7', author: null, published_at: null },
  { id: 903, hash: 'h3', headline: 'Something the model will not answer for', url: 'https://x/3', source: 'Reuters', author: null, published_at: null },
];

// The model answers for the first two and skips the third, every time — so the
// third exercises the "still parked" path after the re-asks are exhausted.
const VERDICTS = {
  'Three bodies recovered after climbers go missing': { is_relevant: false, brand: null, sentiment: null, country: 'Egypt', category: 'other', summary: 'Off-topic wire copy.', pr_angle: '', importance: 1, confidence: 0.9, reason: 'no brand named' },
  'Vodafone Egypt customers report billing errors': { is_relevant: true, brand: 'Vodafone', sentiment: 'negative', country: 'Egypt', category: 'customer_service', summary: 'Customers reported billing errors.', pr_angle: 'Action · respond', importance: 3, confidence: 0.9 },
};

let patched = [];
let patchUrls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

  if (u.includes('/rest/v1/pr_items') && m === 'PATCH') {
    patchUrls.push(u);
    patched.push(JSON.parse(opts.body));
    return ok('');
  }
  // parkedItems
  if (u.includes('/rest/v1/pr_items') && /select=id,hash,headline/.test(u)) return ok(JSON.stringify(PARKED));
  // parkedItemCount (HEAD/GET with count) — one row still unanswered
  if (u.includes('/rest/v1/pr_items')) return { ok: true, status: 200, headers: { get: () => '0-0/1' }, text: async () => '[]', json: async () => [] };
  if (u.includes('/rest/v1/pr_audit')) return ok('');
  if (u.includes('api.anthropic.com')) {
    const prompt = JSON.parse(opts.body).messages[0].content;
    const out = [];
    prompt.split('\n').filter((l) => /^\d+\. \[/.test(l)).forEach((line, i) => {
      const hit = Object.keys(VERDICTS).find((h) => line.includes(h));
      if (hit) out.push({ i, ...VERDICTS[hit] });
    });
    const text = JSON.stringify(out);
    return ok(JSON.stringify({ content: [{ type: 'text', text }] }));
  }
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
let code, out;
const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
await handler({
  method: 'POST', query: { resource: 'reclassify-parked' }, body: { days: 2, limit: 100 },
  headers: { authorization: 'Bearer admin' },
}, res);

assert.strictEqual(code, 200, `the tool runs (got ${code} ${JSON.stringify(out)})`);
assert.strictEqual(out.found, 3, `it picked up all three parked rows (got ${out.found})`);
assert.strictEqual(out.resolved, 2, `the two it got verdicts for were written (got ${out.resolved})`);
assert.strictEqual(out.stillParked, 1, `the unanswerable one stays parked (got ${out.stillParked})`);
// The distinction that matters: this run RESCUED a real Vodafone story.
assert.strictEqual(out.kept, 1, `a rescued relevant story is reported, not lost in a bulk count (got ${out.kept})`);

// Verdicts must land on the EXISTING rows, by id.
assert.deepStrictEqual(patchUrls.map((u) => u.match(/id=eq\.(\d+)/)[1]).sort(), ['901', '902'],
  `written by id onto the existing cards (got ${JSON.stringify(patchUrls)})`);
// …and must not rewrite the card's identity or its ingest provenance.
for (const p of patched) {
  for (const forbidden of ['hash', 'url', 'seen_at', 'headline']) {
    assert.ok(!(forbidden in p), `a re-run never rewrites ${forbidden} — the card keeps its identity and coverage`);
  }
  assert.ok('category' in p && p.category !== 'unclassified', 'the parked marker is cleared');
  assert.ok('is_relevant' in p, 'and relevance is set from the verdict');
}
const vod = patched.find((p) => p.brand === 'Vodafone');
assert.ok(vod, 'the Vodafone story got its real verdict');
assert.strictEqual(vod.is_relevant, true, 'and is now visible on the board');
assert.strictEqual(vod.importance, 3, 'with the Impact the classifier gave it');

console.log('RECLASSIFY-TOOL OK — parked rows are re-screened in place by id (identity and coverage untouched), a rescued relevant story is reported separately from cleared noise, and an item the model still will not answer for stays parked rather than guessed at');
