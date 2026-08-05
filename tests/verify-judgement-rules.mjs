// Judgement-call invariants: the rules that exist ONLY because a real story was
// scored two different ways in production. Each one is a decision the model
// would otherwise make by mood, so each has to be written down — and stay
// written down. These assert on the exact strings sent to the model, not on a
// grep of the source, so a refactor that drops a rule fails here.
//
// The trigger (2026-07-31): a composer accused another artist of plagiarising
// the melody in a Vodafone ad. Two outlets covered it 90 minutes apart. One
// card came out "Negative — needs a response", the other "Neutral — market &
// noted". Two separate defects: nothing told the classifier how to score a
// controversy the brand is NOT a party to, and nothing told the de-duplicator
// that "Walid/Waleed" and "Tawlet/Too Late" are the same names.
import assert from 'node:assert';
import { SYSTEM } from '../lib/classify.js';
import { SAME_EVENT_SYSTEM } from '../lib/dedupe-semantic.js';

// ── classifier: brand named, brand not accused ──
const rule = SYSTEM.slice(SYSTEM.indexOf('THE BRAND IS NAMED BUT IS NOT THE ACCUSED'));
assert.ok(rule.length > 200, 'the classifier carries the not-the-accused rule');
assert.ok(/is the SUBJECT of a public controversy/.test(rule), 'the rule is scoped to the brand\'s own campaign/product being the subject');
assert.ok(/DO NOT/.test(rule) && /neutral/i.test(rule), 'the rule explicitly rejects the tempting "neutral" reading');
assert.ok(/"negative" for that brand/.test(rule), 'the rule lands on negative');
// Severity, not sentiment, is what softens these — otherwise every ad row would
// read as a crisis.
assert.ok(/SEVERITY, not the\s*\n?\s*sentiment/.test(rule) || /severity/i.test(rule), 'the rule moves the softening onto severity');
assert.ok(/2-3/.test(rule), 'the rule pins the severity band');
// The worked example IS the case that failed, so it can never silently regress.
assert.ok(/plagiaris/i.test(rule) && /melody/i.test(rule), 'the worked example is the melody-plagiarism case');
assert.ok(/sentiment negative/.test(rule), 'the worked example states the verdict outright');

// The rule must sit in the SENTIMENT section, not somewhere the model reads as
// advice about relevance or severity.
const sentIdx = SYSTEM.indexOf('2. sentiment');
const sevIdx = SYSTEM.indexOf('3. severity');
const ruleIdx = SYSTEM.indexOf('THE BRAND IS NAMED BUT IS NOT THE ACCUSED');
assert.ok(sentIdx < ruleIdx && ruleIdx < sevIdx, 'the rule lives inside the sentiment definition');

// ── follow-ups to a brand-linked story are RELEVANT, not celebrity noise ──
// The sentiment rule alone was not enough: two follow-ups to the ad-music
// plagiarism row ("the Tawlet song is taken down") arrived with no brand in
// the headline, the model CONNECTED them (brand: Vodafone) and still filed
// them is_relevant:false as music news (live, 5 Aug). The team never saw how
// the story it was already tracking ended. This rule is the relevance half.
const fu = SYSTEM.slice(SYSTEM.indexOf('FOLLOW-UPS TO A BRAND-LINKED STORY'));
assert.ok(fu.length > 200, 'the classifier carries the follow-up relevance rule');
assert.ok(/RELEVANT even when the brand appears nowhere in the headline/.test(fu),
  'the rule covers the unnamed-brand follow-up');
assert.ok(/how the story ends/.test(fu), 'the rule states why: the team must see the ending');
assert.ok(/celebrity\/music\/sport noise/.test(fu), 'the misfiling it forbids is named');
assert.ok(/brand set and is_relevant false/.test(fu) && /non-Egypt or/.test(fu),
  'setting a brand asserts the connection — brand+irrelevant is confined to non-Egypt/duplicate');
assert.ok(/Tawlet song is taken down/.test(fu), 'the worked example is the live miss itself');
// It must live in SCOPE, before the model has decided relevance — not after.
assert.ok(SYSTEM.indexOf('FOLLOW-UPS TO A BRAND-LINKED STORY') < SYSTEM.indexOf('NOT A REGULATORY MONITOR'),
  'the follow-up rule sits in the scope section');

// ── the no-inversion convention it has to coexist with ──
// A story about a rival's ad being disputed is negative for the RIVAL, by the
// same rule — that only works while sentiment stays the brand's own tone.
assert.ok(/never inverted|no inversion/i.test(SYSTEM) || /never re-read it from/i.test(SYSTEM),
  'competitor sentiment is still the brand\'s own tone, never inverted');

// ── de-duplicator: one event, two write-ups ──
assert.ok(/DISPUTE, accusation, complaint, lawsuit or public controversy/.test(SAME_EVENT_SYSTEM),
  'disputes are listed as a same-event pattern (they were not, so two outlets = two cards)');
assert.ok(/NAMES ARE SPELLED MANY WAYS/.test(SAME_EVENT_SYSTEM), 'the transliteration rule is present');
for (const pair of ['Walid / Waleed', 'Tawlet / Too Late']) {
  assert.ok(SAME_EVENT_SYSTEM.includes(pair), `the transliteration rule shows a real example: ${pair}`);
}
assert.ok(/never call two items different events merely because a name is spelled differently/.test(SAME_EVENT_SYSTEM),
  'the rule states the failure mode in the imperative');
// It must not undo the caution that keeps the de-duplicator from eating real
// stories: no shared specifics + unsure still means "not the same".
assert.ok(/When there are no shared specifics and you are unsure, answer false/.test(SAME_EVENT_SYSTEM),
  'the fail-safe (unsure => not a duplicate) survives — losing a story is worse than a duplicate card');

console.log('JUDGEMENT-RULES OK — "brand named but not accused => negative, severity 2-3" is written into the sentiment section with its worked example; the de-duplicator knows disputes are one event and that Arabic names transliterate many ways, without losing its unsure=>keep fail-safe');
