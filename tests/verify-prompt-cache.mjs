// Prompt caching is only worth ASKING for when a read can follow the write.
//
// The system block is ~5k identical tokens on every call, so caching it looks
// obviously right. It wasn't: a cache WRITE bills above normal input and only
// pays back on a later READ, and the provider's ephemeral cache expires in
// ~5 minutes. Live on 2 Aug, once pr_usage was recording: 26 classify runs,
// every one a SINGLE batch, spaced 15+ minutes apart by the urgent poll —
// 128,364 write tokens and ZERO reads. Every call paid the premium; none ever
// collected. The Health page flagged it as "reuse has collapsed", which read
// like a regression when it was the shape of the workload.
//
// So: no cache_control on a one-batch run, and on a many-batch run warm it with
// the first call BEFORE fanning out — firing all batches at once means they
// race the write and all miss.
import assert from 'node:assert';

process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const items = (n) => Array.from({ length: n }, (_, i) => ({
  hash: `h${i}`, headline: `Story ${i}`, url: `https://x/${i}`, source: 'Youm7',
  published_at: null, snippet: '',
}));

// Record each call's system block and when it started/finished, so we can tell
// a warm-then-fan-out from an all-at-once burst.
let calls = [];
let inFlight = 0;
let maxConcurrent = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  if (!u.includes('api.anthropic.com')) throw new Error('unexpected fetch ' + u);
  const body = JSON.parse(opts.body);
  const n = (body.messages[0].content.match(/^\d+\. \[/gm) || []).length;
  const order = calls.length;
  calls.push({ order, cached: !!body.system[0].cache_control, items: n, startedAfter: calls.length });
  inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
  await new Promise((r) => setTimeout(r, 5));     // let a racing sibling overlap
  inFlight--;
  const text = JSON.stringify(Array.from({ length: n }, (_, i) => ({
    i, is_relevant: false, brand: null, sentiment: null, country: 'Egypt',
    category: 'other', summary: 's', pr_angle: '', importance: 1, confidence: 0.9,
  })));
  return { ok: true, status: 200, text: async () => text, json: async () => ({ content: [{ type: 'text', text }] }) };
};

const load = async () => (await import(`${new URL('..', import.meta.url).pathname}/lib/classify.js?t=${Math.random()}`));

// ── one batch: caching must NOT be requested ──
{
  calls = []; inFlight = 0; maxConcurrent = 0;
  const { classify } = await load();
  const out = await classify(items(10));                 // BATCH is 25 → one chunk
  assert.strictEqual(out.length, 10, 'every item still comes back');
  assert.strictEqual(calls.length, 1, 'one batch, one call');
  assert.strictEqual(calls[0].cached, false,
    'a lone call must not request the cache — nothing can read the write back, so it is a premium paid for nothing');
}

// ── many batches: warm on the first, then fan out against a live cache ──
{
  calls = []; inFlight = 0; maxConcurrent = 0;
  const { classify } = await load();
  const out = await classify(items(60));                 // 25 + 25 + 10 → three chunks
  assert.strictEqual(out.length, 60, 'every item comes back');
  assert.strictEqual(calls.length, 3, 'three batches, three calls');
  for (const c of calls) {
    assert.ok(c.cached, 'every call in a multi-batch run asks for the cache');
  }
  // The first must COMPLETE alone. If all three go at once they race the write
  // and every one of them misses — the exact failure this is guarding.
  assert.strictEqual(calls[0].startedAfter, 0, 'the warming call goes first');
  assert.strictEqual(maxConcurrent, 2,
    `the first call finishes before the rest start (max concurrency ${maxConcurrent}; 3 would mean they all raced the write)`);
}

// ── an empty run must not crash on the chunk lookup ──
{
  calls = [];
  const { classify } = await load();
  assert.deepStrictEqual(await classify([]), [], 'no items → no calls, no throw');
  assert.strictEqual(calls.length, 0, 'and the API is never touched');
}

// ── the health check reads a 0% ratio as a REGRESSION, not as this shape ──
// Calls that never cached carry no cache tokens and are skipped entirely, so a
// ratio can only exist where caching was actually requested.
{
  const { cacheEfficiency } = await import(`${new URL('..', import.meta.url).pathname}/lib/usage.js`);
  const now = new Date().toISOString();
  const uncached = Array.from({ length: 8 }, () => ({
    stage: 'classify', created_at: now, input_tokens: 500, output_tokens: 200,
    cache_create_tokens: 0, cache_read_tokens: 0,
  }));
  assert.strictEqual(cacheEfficiency(uncached), null,
    'single-batch runs produce no ratio at all rather than a false 0%');

  const warmed = [
    { stage: 'classify', created_at: now, cache_create_tokens: 5000, cache_read_tokens: 0, input_tokens: 100, output_tokens: 100 },
    ...Array.from({ length: 7 }, () => ({
      stage: 'classify', created_at: now, cache_create_tokens: 0, cache_read_tokens: 5000, input_tokens: 100, output_tokens: 100,
    })),
  ];
  const eff = cacheEfficiency(warmed);
  assert.ok(eff && eff.ratio > 0.8, `a warmed multi-batch run reads far more than it writes (got ${eff && eff.ratio})`);
}

console.log('PROMPT-CACHE OK — a single-batch run never requests the cache (no premium for a write nothing reads); a multi-batch run warms it on the first call and fans out only after that write lands; an empty run makes no call; and a 0% ratio can only mean a real regression');
