// The "today's brief already went out" marker must be stamped when the brief
// reached ANYONE — not only when the RADAR_TO/team copy sent.
//
// It used to be stamped only on the RADAR_TO send. With that var unset (as in
// production since 22 Jul) the marker never advanced, so the !dailyAlreadySent
// guard in front of the subscriber loop was permanently open. The scheduled
// 05:00 run was safe only because it is the sole daily trigger — any manual
// /api/radar hit re-mailed every subscriber the same digest.
//
// Two runs are exercised: one with NO RADAR_TO (subscribers only) which must
// stamp, and a second with the marker fresh which must send nothing.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RESEND_API_KEY = 're_x';
// The condition under test: the team list is unset, exactly as in production.
delete process.env.RADAR_TO;

const SUBSCRIBERS = [
  { email: 'a@example.com', name: null, categories: null },
  { email: 'b@example.com', name: null, categories: null },
];

const STORY = {
  id: 900,
  hash: 'h-900',
  headline: 'Vodafone Egypt expands its fibre rollout to six governorates',
  summary: 'Vodafone Egypt said it is extending fibre coverage to six more governorates.',
  url: 'https://telegraph.eg/fibre',
  category: 'network',
  sentiment: 'neutral',
  importance: 3,
  brand: 'Vodafone',
  is_relevant: true,
  published_at: new Date().toISOString(),
  seen_at: new Date().toISOString(),
};

// A run with no fresh candidates in the feed: the digest is built from what is
// already stored (recentItems), which is the normal shape of a daily run.
const emptyRss = '<?xml version="1.0"?><rss><channel></channel></rss>';

function harness({ markerAt }) {
  const sent = [];
  let stateWrites = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

    if (u.includes('news.google.com') || u.includes('/rss') || u.includes('/feed')) return ok(emptyRss);
    if (u.includes('/rest/v1/pr_state') && m === 'POST') { stateWrites++; return ok(''); }
    if (u.includes('/rest/v1/pr_state')) {
      return ok(markerAt ? JSON.stringify([{ updated_at: new Date(markerAt).toISOString() }]) : '[]');
    }
    if (u.includes('/rest/v1/pr_subscribers')) return ok(JSON.stringify(SUBSCRIBERS));
    // recentItems — the stored story that makes up today's digest.
    if (u.includes('/rest/v1/pr_items') && m === 'GET' && /select=\*&is_relevant=is\.true/.test(u)) return ok(JSON.stringify([STORY]));
    if (u.includes('api.resend.com') && m === 'POST') {
      sent.push(JSON.parse(opts.body));
      return ok('{"id":"x"}');
    }
    if (u.includes('api.anthropic.com')) return ok(JSON.stringify({ content: [{ type: 'text', text: '[]' }] }));
    if (u.includes('/rest/v1/')) return ok('[]');
    throw new Error('unexpected fetch ' + u);
  };
  return { sent, states: () => stateWrites };
}

const load = async () => (await import(`${new URL('..', import.meta.url).pathname}/api/radar.js?t=${Math.random()}`)).default;
const run = async (handler) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
  await handler({ query: {}, headers: { authorization: 'Bearer admin' } }, res);
  return { code, body };
};

// ── run 1: no marker, no RADAR_TO — the subscribers are the only recipients ──
{
  const h = harness({ markerAt: 0 });
  const { code } = await run(await load());
  assert.strictEqual(code, 200, 'run returns 200');

  const to = h.sent.flatMap((m) => [].concat(m.to || []));
  for (const s of SUBSCRIBERS) {
    assert.ok(to.includes(s.email), `the brief reached subscriber ${s.email} (sent to ${JSON.stringify(to)})`);
  }
  // The whole point: a send with no RADAR_TO still records that today is done.
  assert.ok(h.states() >= 1,
    'the marker is stamped when only subscribers were mailed — otherwise a manual re-run mails them all again');
}

// ── run 2: marker written moments ago — today is already done ──
{
  const h = harness({ markerAt: Date.now() - 60e3 });
  const { code } = await run(await load());
  assert.strictEqual(code, 200, 'second run returns 200');
  assert.strictEqual(h.sent.length, 0,
    `a second trigger the same day sends nothing (sent ${JSON.stringify(h.sent.map((m) => m.to))})`);
}

// ── a dry run must never stamp: it sent nothing, so today is not done ──
{
  const h = harness({ markerAt: 0 });
  const handler = await load();
  let code;
  const res = { status: (c) => { code = c; return res; }, json: () => res, setHeader() {}, end() {} };
  await handler({ query: { dry: '1' }, headers: { authorization: 'Bearer admin' } }, res);
  assert.strictEqual(code, 200, 'dry run returns 200');
  assert.strictEqual(h.sent.length, 0, 'a dry run sends nothing');
  assert.strictEqual(h.states(), 0, 'a dry run does not stamp the marker — the real send still has to happen');
}

console.log('DAILY-ONCE OK — with RADAR_TO unset a subscriber-only send still stamps daily_bulletin_sent, so a second trigger the same day is a no-op; a dry run stamps nothing');
