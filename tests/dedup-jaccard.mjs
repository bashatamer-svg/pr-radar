// Task 2 — labeled Jaccard check against the REAL STOPWORDS in api/radar.js.
// Pulls the STOPWORDS Set straight out of the source (zero drift) and replicates
// tokenize()/jaccard() verbatim (unchanged by this task).
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('..', import.meta.url).pathname + '/api/radar.js', 'utf8');
const inner = src.match(/const STOPWORDS = new Set\(\[([\s\S]*?)\]\);/)[1];
const STOPWORDS = new Set(new Function('return [' + inner + ']')());

// verbatim from api/radar.js (tokenize + jaccard) ─ do not diverge
function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\w\s؀-ۿ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
  );
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
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

console.log('\nDEDUP JACCARD OK — distinct/developing stay separate at 0.55; reworded reposts still merge at 0.5');
