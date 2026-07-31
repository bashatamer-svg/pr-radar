// The LLM narrative pass: it must improve the grouping when it answers well,
// and be INVISIBLE when it doesn't. Everything the model returns is treated as
// untrusted — ids are validated against the input, duplicates dropped, groups
// too small discarded — because a narrative row that opens cards it doesn't
// contain is worse than no narrative row at all.
//
// The sandbox has no ANTHROPIC_API_KEY and cannot call the real API, so the
// Anthropic response is mocked here. What this pins is the contract and the
// failure handling; the grouping QUALITY is proven in production.
import assert from 'node:assert';
import { buildNarratives, _resetNarrativeCache } from '../lib/narratives.js';

const now = new Date();
const day = (n) => new Date(now.getTime() - n * 864e5).toISOString();
const cairo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const days = [];
for (let i = 6; i >= 0; i--) days.push(cairo.format(new Date(now.getTime() - i * 864e5)));
const dayIdx = new Map(days.map((d, i) => [d, i]));

const it = (id, headline, summary, extra = {}) => ({
  id, brand: 'Vodafone', sentiment: 'neutral', category: 'campaign', importance: 2,
  headline, summary, published_at: day(1), seen_at: day(1), ...extra,
});
// Two threads the token pass merges into one (both are brand Vodafone, category
// campaign, and both say "Vodafone ad"): the sponsorship and a plagiarism row.
const ITEMS = [
  it(1, 'Vodafone ad unveils the new Al Ahly stadium', 'Vodafone launches an advertisement featuring the new Al Ahly stadium.'),
  it(2, 'Vodafone ad for Al Ahly stadium draws millions of views', 'The Vodafone stadium advertisement draws millions of views online.'),
  it(3, 'Composer accuses producer of copying the Vodafone ad melody', 'A composer accuses a producer of plagiarising the melody used in a Vodafone advertisement.', { sentiment: 'negative' }),
  it(4, 'Second composer backs plagiarism claim over Vodafone ad song', 'A second composer supports the plagiarism claim about the Vodafone advertisement song.', { sentiment: 'negative' }),
];

let calls = 0, reply = null;
const origKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key';
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.anthropic.com')) throw new Error(`unexpected fetch: ${url}`);
  calls++;
  if (reply instanceof Error) throw reply;
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) };
};
const run = async () => buildNarratives(ITEMS, days, dayIdx);
const byTitle = (ns, t) => ns.find((n) => n.name === t);

// 1. A good answer replaces the token grouping AND supplies the title.
_resetNarrativeCache(); calls = 0;
reply = [
  { title: 'Al Ahly stadium advertisement', ids: [1, 2] },
  { title: 'Vodafone ad melody plagiarism claim', ids: [3, 4] },
];
let ns = await run();
assert.strictEqual(ns.length, 2, 'the model split one token cluster into the two real threads');
assert.deepStrictEqual(byTitle(ns, 'Al Ahly stadium advertisement').ids.sort(), [1, 2], 'sponsorship thread membership');
assert.deepStrictEqual(byTitle(ns, 'Vodafone ad melody plagiarism claim').ids.sort(), [3, 4], 'plagiarism thread membership');
assert.strictEqual(byTitle(ns, 'Vodafone ad melody plagiarism claim').negative, 2, 'sentiment split is recomputed from the FINAL membership');
assert.ok(ns.every((n) => n.ids.length === n.total && n.idsTotal === n.total), 'every counted story stays deep-linkable');

// 2. Memoised: the same window + same items must not pay for a second call.
const before = calls;
await run();
assert.strictEqual(calls, before, 'a repeat request for the same items reuses the cached grouping');

// 3. Hostile/garbled output is filtered, not trusted.
_resetNarrativeCache();
reply = [
  { title: 'Has an unknown id', ids: [1, 2, 9999] },       // 9999 is not ours
  { title: 'Reuses an id', ids: [2, 3] },                  // 2 already placed
  { title: 'Too small after filtering', ids: [3] },
  { title: '', ids: [3, 4] },                              // no title
  { ids: [3, 4] },                                          // malformed
];
ns = await run();
const all = ns.flatMap((n) => n.ids);
assert.ok(!all.includes(9999), 'an id the model invented is dropped');
assert.strictEqual(new Set(all).size, all.length, 'no item appears in two narratives');
assert.ok(ns.every((n) => n.total >= 2 && n.name), 'groups that fall below 2 stories, or have no title, are dropped');

// 4. Every failure mode falls back to the deterministic grouping — never empty,
//    never a throw. This is the path production takes if the key is unset.
for (const [label, bad] of [
  ['network error', new Error('socket hang up')],
  ['not an array', { oops: true }],
  ['empty array', []],
  ['all groups invalid', [{ title: 'x', ids: [777, 888] }]],
]) {
  _resetNarrativeCache();
  reply = bad;
  const out = await run();
  assert.ok(out.length >= 1, `${label}: falls back to token clustering instead of an empty section`);
  assert.ok(out.every((n) => n.total >= 2 && n.name), `${label}: fallback narratives are still well-formed`);
}

// 5. With no API key at all the pass is skipped silently (tests, local dev).
_resetNarrativeCache();
delete process.env.ANTHROPIC_API_KEY;
calls = 0;
const noKey = await run();
assert.strictEqual(calls, 0, 'no API key → no call attempted');
assert.ok(noKey.length >= 1, 'no API key → deterministic narratives still render');
if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origKey;

console.log('NARR-AI OK — model grouping applied and titled; invented/duplicate ids dropped; every failure mode (network, malformed, empty, no key) degrades to token clustering; repeats served from cache');
