// Task 10 — GEO monitoring. Verify: OFF by default (no calls), dormant with no
// engine keys, and a full flagged run (mocked engines + mocked Haiku audit).
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'cron';
process.env.BOARD_URL = 'https://pr.example/';
process.env.RADAR_TO = 'team@vodafone.com';

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/geo.js');
const call = async (query, headers = {}) => {
  let code, body; const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; } };
  await handler({ query, headers }, res);
  return { code, body };
};

// auth — /api/geo is OPERATOR-gated: it calls out to paid answer engines and can
// email the findings, so the read-only RADAR_TOKEN is refused (see the model in
// lib/auth.js; the whole table is pinned by verify-token-privilege).
assert.strictEqual((await call({ t: 'nope' })).code, 401, 'no bearer is challenged');
assert.strictEqual((await call({}, { authorization: 'Bearer tok' })).code, 403,
  'the read-only RADAR_TOKEN cannot run the geo check');

// GEO_ENABLED unset → feature off, zero external calls
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
let r = await call({}, { authorization: 'Bearer cron' });
assert.strictEqual(r.code, 200);
assert.strictEqual(r.body.enabled, false, 'disabled by default');
assert.strictEqual(calls, 0, 'no external calls when disabled');

// enabled but NO engine keys → idle, still no calls
process.env.GEO_ENABLED = '1';
calls = 0;
r = await call({}, { authorization: 'Bearer cron' });
assert.strictEqual(r.body.enabled, true);
assert.strictEqual(r.body.checked, 0);
assert.ok(/no engine API keys/.test(r.body.note || ''), 'idle note');
assert.strictEqual(calls, 0, 'no calls without engine keys');

// full run: enable Perplexity + OpenAI + the Anthropic auditor. Mock all three.
process.env.PERPLEXITY_API_KEY = 'px';
process.env.OPENAI_API_KEY = 'oa';
process.env.ANTHROPIC_API_KEY = 'an';
process.env.GEO_MAX_PROBES = '2';   // keep the test cheap: 2 engines × 2 probes = 4

let asks = 0, audits = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('perplexity.ai')) { asks++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Vodafone Egypt is the largest operator; some users complain about Vodafone Cash outages.' } }] }) }; }
  if (u.includes('openai.com')) { asks++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Vodafone Egypt is owned by Orange and is the smallest operator in Egypt.' } }] }) }; }
  if (u.includes('api.anthropic.com')) {
    audits++;
    const body = JSON.parse(opts.body);
    const ans = body.messages[0].content;
    // the OpenAI answer contains a factual error (owned by Orange / smallest)
    const bad = /owned by Orange|smallest/.test(ans);
    const verdict = bad
      ? { sentiment: 'negative', negative_framing: true, factual_issues: ['claims Vodafone Egypt is owned by Orange', 'calls it the smallest operator'], severity: 5, note: 'Serious factual drift on ownership and market position.' }
      : { sentiment: 'neutral', negative_framing: false, factual_issues: [], severity: 1, note: 'Accurate summary.' };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(verdict) }] }) };
  }
  if (u.includes('api.resend.com')) { globalThis.__sent = (globalThis.__sent || 0) + 1; return { ok: true, json: async () => ({ id: 'e' }) }; }
  throw new Error('unexpected ' + u);
};

r = await call({}, { authorization: 'Bearer cron' });
assert.strictEqual(r.body.enabled, true);
assert.deepStrictEqual(r.body.engines, ['Perplexity', 'ChatGPT (OpenAI)']);
assert.strictEqual(r.body.checked, 4, '2 engines × 2 probes');
assert.strictEqual(asks, 4);
assert.strictEqual(audits, 4);
assert.ok(r.body.flagged >= 2, `flagged the OpenAI drift answers, got ${r.body.flagged}`);
// findings present on interactive call, sorted severity-desc
assert.ok(Array.isArray(r.body.findings) && r.body.findings.length === 4);
assert.strictEqual(r.body.findings[0].verdict.severity, 5, 'worst finding first');
const drift = r.body.findings.find((f) => f.verdict.factual_issues.length);
assert.ok(/Orange/.test(drift.verdict.factual_issues.join(' ')), 'factual drift captured');

// email gate: send=1 but GEO_ALERTS_ENABLED unset → no email
globalThis.__sent = 0;
r = await call({ send: '1' }, { authorization: 'Bearer cron' });
assert.strictEqual(r.body.sent, false);
assert.ok(/GEO_ALERTS_ENABLED/.test(r.body.note || ''));
assert.strictEqual(globalThis.__sent, 0);
assert.strictEqual(r.body.findings, undefined, 'send path returns summary, not full findings');

// enable email → sends because there are flagged findings
process.env.GEO_ALERTS_ENABLED = '1';
globalThis.__sent = 0;
r = await call({ send: '1' }, { authorization: 'Bearer cron' });
assert.strictEqual(r.body.sent, true, 'sends when enabled + flagged');
assert.strictEqual(globalThis.__sent, 1);

// render an email fixture for eyeballing
const { runGeoCheck, renderGeoEmail } = await import(new URL('..', import.meta.url).pathname + '/lib/geo.js');
const full = await runGeoCheck();
writeFileSync(new URL('./out/', import.meta.url).pathname + 'geo.html', renderGeoEmail(full, 'https://pr.example/'));

console.log('ALL TASK 10 TESTS PASSED — off-by-default, idle-without-keys, flagged', r.body.flagged, 'of', r.body.checked);
