// Replays the byline case ledger (`byline-cases.mjs`) — every wrong byline ever
// reported against the live board, plus every real name a guard has previously
// eaten or could still eat.
//
// This is the regression net for the whole extractor. Adding a case is the FIRST
// step when a bad byline is reported, before touching lib/author.js; see the
// playbook in CLAUDE.md. The ledger carries the WHY for each entry, so this file
// stays deliberately thin — it is a runner, not a place to add prose.
import assert from 'node:assert';
import { REJECT, ACCEPT } from './byline-cases.mjs';
import { extractAuthorFromHtml, judgeByline } from '../lib/author.js';

let pass = 0;
const ids = new Set();

// A case is either a bare candidate (judged directly) or markup (run through
// the whole cascade). Both end at the same answer: what would the board show?
function resolve(c) {
  if (c.html) return extractAuthorFromHtml(c.html, c.outlet, { headline: c.headline ?? null });
  const v = judgeByline(c.raw, { outlet: c.outlet, headline: c.headline ?? null });
  return v.ok ? v.name : null;
}

for (const [group, cases] of [['REJECT', REJECT], ['ACCEPT', ACCEPT]]) {
  console.log(`\n${group}`);
  for (const c of cases) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing case id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.why && c.reported, `${c.id}: every case records when it was reported and why`);
    assert.ok(c.html || c.raw, `${c.id}: a case needs either raw or html`);

    const got = resolve(c);
    assert.strictEqual(got, c.expect,
      `${c.id} (${c.outlet || 'any outlet'}, reported ${c.reported})\n    ${c.why}\n    got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)}`);

    // Pinning the REASON as well as the answer: without it a case can start
    // passing for the wrong cause after a refactor — rejected as 'too-long'
    // when the rule it was written to prove is 'markup'.
    if (c.rule) {
      const v = judgeByline(c.raw, { outlet: c.outlet, headline: c.headline ?? null });
      assert.strictEqual(v.reason, c.rule,
        `${c.id}: expected rule "${c.rule}" to fire, got "${v.reason}"`);
    }
    pass++;
    console.log(`  ✓ ${c.id.padEnd(32)} ${c.expect === null ? 'shows nothing' : `→ ${c.expect}`}${c.rule ? `  [${c.rule}]` : ''}`);
  }
}

const total = REJECT.length + ACCEPT.length;
console.log(`\n${pass}/${total} CASES PASS — ${REJECT.length} reported mistakes stay fixed, ${ACCEPT.length} real bylines stay findable`);
assert.strictEqual(pass, total, 'not every case passed');
