// An OMISSION IS NOT A VERDICT.
//
// classifyChunk maps the model's reply onto the batch by each object's "i".
// A reply that simply leaves items out parses cleanly, so the hard-failure
// split never fired — every skipped item was parked category:'unclassified',
// hidden from the board and the brief.
//
// Live on 1 Aug: one batch of 25 off-topic Reuters wire stories came back with
// no verdicts at all, all 25 parked, and the admin health panel raised a
// CRITICAL reading "an API error or a spend cap" — neither of which had
// happened. The model had simply declined to answer for obvious junk.
//
// The fix must re-ask for the gaps, and must NOT quietly recast an omission as
// "not relevant": that would drop a real Vodafone story the model forgot.
import assert from 'node:assert';

process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const items = (n, prefix = 'Story') => Array.from({ length: n }, (_, i) => ({
  hash: `h${i}`, headline: `${prefix} ${i}`, url: `https://x/${i}`,
  source: 'Reuters', published_at: null, snippet: '',
}));

const verdict = (i, extra = {}) => ({
  i, is_relevant: true, brand: 'Vodafone', sentiment: 'neutral', country: 'Egypt',
  category: 'corporate', summary: 's', pr_angle: '', importance: 2, confidence: 0.8, ...extra,
});

// Count how many items each request carried, so we can prove a re-ask asked for
// the GAPS rather than resending the whole batch.
let asked = [];
function mockAnthropic(reply) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    if (!u.includes('api.anthropic.com')) throw new Error('unexpected fetch ' + u);
    const body = JSON.parse(opts.body);
    const prompt = body.messages[0].content;
    // The batch is rendered as "0. [source] headline" lines.
    const n = (prompt.match(/^\d+\. \[/gm) || []).length;
    asked.push(n);
    const text = JSON.stringify(reply(n, asked.length));
    return { ok: true, status: 200, text: async () => text, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
}

const load = async () => (await import(`${new URL('..', import.meta.url).pathname}/lib/classify.js?t=${Math.random()}`));

// ── 1. A partial reply: the gaps are re-asked, not parked ──
{
  asked = [];
  // First call answers only items 0 and 1 of 5. Any later call answers in full.
  mockAnthropic((n, callNo) => callNo === 1 ? [verdict(0), verdict(1)] : Array.from({ length: n }, (_, i) => verdict(i)));
  const { classify } = await load();
  const out = await classify(items(5));

  assert.strictEqual(out.length, 5, 'every input item comes back');
  const parked = out.filter((r) => r.category === 'unclassified');
  assert.strictEqual(parked.length, 0, `nothing is parked when a re-ask can answer (parked ${parked.length})`);
  // The re-ask must carry ONLY the three gaps — resending all five would cost
  // double and re-answer what we already had.
  assert.deepStrictEqual(asked, [5, 3], `the re-ask asked for just the 3 skipped items (asked ${JSON.stringify(asked)})`);
}

// ── 2. An EMPTY reply for a whole batch: split, don't repeat ──
// This is the 1 Aug failure. An empty array parses fine, so nothing threw.
{
  asked = [];
  // Never answers on a full-size batch; answers once the batch is split small.
  mockAnthropic((n) => n > 3 ? [] : Array.from({ length: n }, (_, i) => verdict(i)));
  const { classify } = await load();
  const out = await classify(items(8));

  assert.strictEqual(out.length, 8, 'all eight come back');
  const parked = out.filter((r) => r.category === 'unclassified');
  assert.strictEqual(parked.length, 0, `splitting rescues a batch the model answered nothing for (parked ${parked.length})`);
  // It must not have re-sent the same 8 over and over.
  const fullResends = asked.filter((n) => n === 8).length;
  assert.strictEqual(fullResends, 1, `the identical full batch is not resent (sent it ${fullResends}x, asked ${JSON.stringify(asked)})`);
}

// ── 3. A model that NEVER answers still terminates, and parks honestly ──
{
  asked = [];
  mockAnthropic(() => []);
  const { classify } = await load();
  const out = await classify(items(4));

  assert.strictEqual(out.length, 4, 'every item still comes back');
  for (const r of out) {
    assert.strictEqual(r.category, 'unclassified', 'a genuinely unanswered item is parked, not invented');
    assert.strictEqual(r.is_relevant, false, 'and hidden from the board');
  }
  assert.ok(asked.length < 60, `the retry budget terminates rather than looping (made ${asked.length} calls)`);
}

// ── 4. The fail-safe direction: an omission must NEVER become "not relevant" ──
// If the model skips a real Vodafone crisis, the item must end up parked for
// review — never silently stored as an irrelevant row nobody looks at.
{
  asked = [];
  mockAnthropic((n, callNo) => callNo === 1 ? [verdict(0)] : []);
  const { classify } = await load();
  const out = await classify(items(2));
  const skipped = out[1];
  assert.strictEqual(skipped.category, 'unclassified',
    'a skipped item is parked for review, not recast as a judged-irrelevant story');
  assert.strictEqual(skipped.confidence, 0, 'and carries no false confidence');
  assert.ok(/no verdict/i.test(String(skipped.reason || '')), `the reason says the model never answered (got ${skipped.reason})`);
}

console.log('CLASSIFY-GAPS OK — a partial reply is re-asked for just its gaps, an empty reply is split rather than repeated, a never-answering model terminates and parks honestly, and an omission is never recast as "not relevant"');
