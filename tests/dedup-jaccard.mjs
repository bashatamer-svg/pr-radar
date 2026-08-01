// Labeled Jaccard check against the REAL tokeniser and stopword list.
// These used to be scraped out of api/radar.js source and re-implemented here
// with a "do not diverge" comment — a hazard that only held while someone
// remembered. They now live in lib/dedupe.js and are imported, so the test
// exercises the exact code the pipeline and the admin duplicate-finder share.
import assert from 'node:assert';
import { STOPWORDS, tokenize, jaccard } from '../lib/dedupe.js';

const J = (x, y) => jaccard(tokenize(x), tokenize(y));

console.log('STOPWORDS size:', STOPWORDS.size, '| includes brand/geo:',
  ['vodafone','orange','etisalat','telecom','egypt','cash','mobile','money','فودافون','اتصالات'].every((w) => STOPWORDS.has(w)));

// ── HEADLINE pass: distinct + developing same-brand stories must stay SEPARATE (< 0.55) ──
const HEAD = [
  ['Orange launches 5G network across Egypt',        'Orange raises prices on mobile data bundles',      'distinct: 5G launch vs price hike'],
  ['Vodafone Cash hit by nationwide service outage',  'Vodafone offers compensation after the Cash outage','developing: outage vs next-day compensation'],
  ['Etisalat Misr wins new spectrum in Egypt',        'Etisalat Misr faces billing complaints from users', 'distinct: spectrum win vs billing complaints'],
  ['Telecom Egypt reports record quarterly profit',   'Telecom Egypt outage disrupts internet nationwide', 'distinct: earnings vs outage'],
];
console.log('\nHEADLINE pass (must be < 0.55 → separate cards):');
for (const [a, b, label] of HEAD) {
  const s = J(a, b);
  console.log(`  ${s.toFixed(3)}  ${s < 0.55 ? 'SEPARATE ✓' : 'MERGED ✗'}  — ${label}`);
  assert.ok(s < 0.55, `distinct/developing pair merged at ${s.toFixed(3)}: ${label}`);
}

// ── SUMMARY pass: genuine same-event reposts (reworded) must still MERGE (>= 0.5) ──
// The summary threshold is unchanged (0.5); these share distinctive event words.
const SUM = [
  [ 'Customers reported a nationwide service outage on Sunday affecting transfers and payments for hours',
    'A nationwide service outage on Sunday left customers unable to complete transfers or payments for hours',
    'same-event repost: nationwide Sunday outage / transfers / payments' ],
  [ 'Regulator fined the operator fifty million pounds over misleading advertising about unlimited internet bundles',
    'The operator was fined fifty million pounds by the regulator for misleading unlimited internet bundle advertising',
    'same-event repost: fifty-million fine, misleading unlimited bundle ads' ],
];
console.log('\nSUMMARY pass (must be >= 0.5 → still merged as reposts):');
for (const [a, b, label] of SUM) {
  const s = J(a, b);
  console.log(`  ${s.toFixed(3)}  ${s >= 0.5 ? 'MERGED ✓' : 'SPLIT ✗'}  — ${label}`);
  assert.ok(s >= 0.5, `genuine repost failed to merge at ${s.toFixed(3)}: ${label}`);
}

// The pipeline and the admin duplicate-finder must share one notion of "same
// story" — a second copy of these primitives is how the two would drift apart.
assert.strictEqual(typeof tokenize, 'function');
assert.ok(STOPWORDS.size > 30, 'the real stopword list is loaded, not a stub');

console.log('\nDEDUP JACCARD OK — distinct/developing stay separate at 0.55; reworded reposts still merge at 0.5; primitives imported from lib/dedupe.js, not re-implemented');
