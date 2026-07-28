// Task 1 smoke test — mocks fetch to exercise:
//  (1) notify.js payload built from real pr_items fields (pr_angle Action line, brand, spread)
//  (2) classify.js split-in-half retry isolating a poison item
import assert from 'node:assert';

process.env.URGENT_WEBHOOK_URL = 'https://hooks.example/x';
process.env.RADAR_TOKEN = 'tok';
process.env.ANTHROPIC_API_KEY = 'test';

// ---- (1) notify ----
let captured = null;
globalThis.fetch = async (url, opts) => {
  captured = JSON.parse(opts.body);
  return { ok: true, status: 200 };
};

const { postUrgentWebhook } = await import(new URL('..', import.meta.url).pathname + '/lib/notify.js');
const item = {
  id: 42, hash: 'h1', headline: 'Vodafone Cash outage spreads', url: 'https://x/a',
  resolved_url: 'https://x/a-final', brand: 'Vodafone', sentiment: 'negative',
  importance: 5, category: 'vodafone_cash', country: 'Egypt', summary: 'Outage.',
  pr_angle: 'Read · Cash is down nationwide\nAudience · Cash users\nAction · Prepare a holding line and brief the comms lead today',
  _instances: [{ outlet: 'A', url: 'u1' }, { outlet: 'B', url: 'u2' }, null],
};
const ok = await postUrgentWebhook(item, 'https://board.example');
assert.strictEqual(ok, true);
assert.strictEqual(captured.item.action, 'Prepare a holding line and brief the comms lead today');
assert.strictEqual(captured.item.brand, 'Vodafone');
assert.strictEqual(captured.item.outlets, 2);
assert.strictEqual(captured.item.url, 'https://x/a-final');
assert.ok(captured.text.startsWith('🚨 URGENT · Vodafone · 2 outlets — Vodafone Cash outage spreads'));
assert.ok(captured.text.includes('→ Prepare a holding line'));
assert.ok(captured.text.includes('https://board.example#item-42'), 'webhook deep-links the item with NO ?t= token (Task 4)');
assert.ok(!/[?&]t=/.test(captured.text), 'no shared token leaked into the webhook link');
assert.ok(!('so_what' in captured.item) && !('tier' in captured.item) && !('regulator' in captured.item));
// pr_angle with dash Action placeholder → no action line
const capturedText = captured.text;
await postUrgentWebhook({ ...item, pr_angle: 'Read · x\nAudience · y\nAction · —' }, 'https://b');
assert.strictEqual(captured.item.action, '');
console.log('notify OK:', capturedText.split('\n')[0]);

// ---- (2) classify split-retry ----
// Mock Anthropic: any batch containing the poison headline returns garbage
// (unparseable), forcing recursive splits; clean batches return verdicts.
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const userText = body.messages[0].content;
  const lines = userText.split('\n').filter((l) => /^\d+\.\s/.test(l));
  if (userText.includes('POISON')) {
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'not json at all' }] }) };
  }
  const arr = lines.map((_, i) => ({
    i, is_relevant: true, brand: 'Vodafone', sentiment: 'neutral', country: 'Egypt',
    category: 'network', summary: 's', pr_angle: 'Read · —\nAudience · —\nAction · —',
    importance: 2, confidence: 0.9, deadline: null,
  }));
  return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(arr) }] }) };
};

const { classify } = await import(new URL('..', import.meta.url).pathname + '/lib/classify.js');
const items = Array.from({ length: 7 }, (_, i) => ({
  hash: `h${i}`, headline: i === 3 ? 'POISON item' : `Story ${i}`, url: `https://x/${i}`,
  source: 'Outlet', published_at: '2026-07-22T00:00:00Z',
}));
const out = await classify(items);
assert.strictEqual(out.length, 7);
const keys = out.map((r) => Object.keys(r).sort().join(','));
assert.ok(keys.every((k) => k === keys[0]), 'identical key set across all records (PGRST102)');
const bad = out.filter((r) => r.category === 'unclassified');
assert.strictEqual(bad.length, 1);
assert.strictEqual(bad[0].hash, 'h3');
assert.strictEqual(bad[0].is_relevant, false);
assert.strictEqual(bad[0].confidence, 0);
const good = out.filter((r) => r.category !== 'unclassified');
assert.strictEqual(good.length, 6);
assert.ok(good.every((r) => r.is_relevant === true && r.brand === 'Vodafone'));
console.log('classify OK: poison isolated to h3, 6/7 classified, uniform keys');
console.log('ALL SMOKE TESTS PASSED');
