// The board's 🔔 — fire the REAL urgent path for one stored card, after the
// fact.
//
// Alerts fire at ingest only, so when a human corrects a card INTO
// alert-qualifying territory the alert it should have had has already been
// silently skipped. Live case, 5 Aug: a court story accusing an unnamed
// "شركة اتصالات" of registering five lines without consent arrived branded e&
// (no alert — a rival negative at Impact 3 does not qualify), was corrected to
// Vodafone (qualifies), and no path existed to fire the alert late.
//
// Load-bearing properties pinned here: the live rule gates it (no paging the
// team with non-qualifying cards), it reaches the REAL alert list (unlike the
// admin's delivery test, which must reach only the admin), a second click does
// not page twice, and force exists for a genuine re-alert.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RESEND_API_KEY = 're_x';
process.env.RADAR_FROM = 'radar@example.com';
delete process.env.RADAR_TO;         // production shape: subscriber fallback

const CARD = {
  id: 1919, is_relevant: true, brand: 'Vodafone', sentiment: 'negative', importance: 3,
  headline: 'إيناس عز الدين تتهم شركة اتصالات بتسجيل 5 خطوط باسمها دون علمها',
  summary: 'A public figure accuses a telecom company of registering lines in her name.',
  pr_angle: 'Read · KYC failure\nAudience · subscribers\nAction · Monitor court filings',
  published_at: new Date().toISOString(), url: 'https://x/1', hash: 'h1',
};

let items = [CARD];
let sent = [];
let audits = [];
let state = {};                      // pr_state rows, keyed
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });
  if (u.includes('/rest/v1/pr_users')) return ok(JSON.stringify([{ email: 'boss@vodafone.com', role: 'admin', active: true }]));
  if (u.includes('/rest/v1/pr_audit') && m === 'POST') { audits.push(JSON.parse(opts.body)); return ok(''); }
  if (u.includes('/rest/v1/pr_items')) return ok(JSON.stringify(items));
  if (u.includes('/rest/v1/pr_subscribers')) return ok(JSON.stringify([{ email: 'sub1@example.com' }, { email: 'sub2@example.com' }]));
  if (u.includes('/rest/v1/pr_state')) {
    const key = decodeURIComponent((u.match(/key=eq\.([^&]+)/) || [])[1] || '');
    if (m === 'POST') { state[JSON.parse(opts.body).key] = JSON.parse(opts.body).updated_at; return ok(''); }
    return ok(JSON.stringify(state[key] ? [{ updated_at: state[key] }] : []));
  }
  if (u.includes('api.resend.com') && m === 'POST') { sent.push(JSON.parse(opts.body)); return ok('{"id":"em_1"}'); }
  if (u.includes('/rest/v1/')) return ok('[]');
  if (u.includes('auth/v1')) return ok(JSON.stringify({ email: 'boss@vodafone.com' }));
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const call = async (body, bearer = 'admin') => {
  let code, out;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({ method: 'POST', query: { resource: 'send-alert' }, body, headers: { authorization: `Bearer ${bearer}` } }, res);
  return { code, out };
};

// ── a qualifying card reaches the REAL alert list ──
{
  const { code, out } = await call({ id: 1919 });
  assert.strictEqual(code, 200, `qualifying card sends (got ${code} ${JSON.stringify(out)})`);
  assert.strictEqual(out.tier, 'ALERT', 'a Vodafone negative at Impact 3 is tier ALERT, not URGENT');
  // ONE MESSAGE PER RECIPIENT (send-guard rule) — two subscribers, two sends.
  assert.strictEqual(sent.length, 2, `fans out per recipient (sent ${sent.length})`);
  const tos = sent.flatMap((s) => [].concat(s.to)).sort();
  assert.deepStrictEqual(tos, ['sub1@example.com', 'sub2@example.com'], 'the REAL list — subscriber fallback, filters ignored');
  assert.ok(sent.every((s) => /^ALERT — /.test(s.subject)), 'subject carries the tier');
  assert.strictEqual(out.emailed, 2, 'the caller is told how many were reached');
  assert.ok(audits.some((a) => JSON.stringify(a).includes('alert.manual')), 'the send is audited');
}

// ── a second click must NOT page the team twice ──
{
  sent = [];
  const { code, out } = await call({ id: 1919 });
  assert.strictEqual(code, 409, `repeat is refused (got ${code})`);
  assert.match(String(out.error), /already sent/, 'and says when');
  assert.strictEqual(sent.length, 0, 'nothing was sent');
  // ...but a genuine re-alert stays possible, deliberately.
  const forced = await call({ id: 1919, force: true });
  assert.strictEqual(forced.code, 200, 'force sends again');
  assert.strictEqual(sent.length, 2, 'to the full list again');
}

// ── the live rule gates it: a non-qualifying card cannot page the team ──
{
  sent = [];
  // A sector story: negative, but names no operator, so the widened rule still
  // excludes it. (An e& negative WOULD qualify since 5 Aug — rivals alert too.)
  items = [{ ...CARD, id: 7, brand: 'market', sentiment: 'negative', importance: 3 }];
  const { code, out } = await call({ id: 7 });
  assert.strictEqual(code, 400, `non-qualifying card refused (got ${code})`);
  assert.match(String(out.error), /does not qualify/, 'with the rule stated');
  assert.match(String(out.error), /market/, 'and what the card actually is');
  assert.strictEqual(sent.length, 0, 'nothing sent');
}

// ── a hidden card must be unhidden first — alerting on it would advertise a
// card the board does not show ──
{
  items = [{ ...CARD, id: 8, is_relevant: false }];
  const { code } = await call({ id: 8 });
  assert.strictEqual(code, 400, 'hidden card refused');
}

// ── missing card and bad id fail plainly ──
{
  items = [];
  assert.strictEqual((await call({ id: 999 })).code, 404, 'unknown id is a 404');
  assert.strictEqual((await call({ id: 'x' })).code, 400, 'a non-numeric id is a 400');
}

console.log('SEND-ALERT-TOOL OK — 🔔 fires the real urgent path late (subscriber fallback, per-recipient fan-out, tier subject, audited); repeats need force; the live rule, hidden-card and bad-id gates all refuse before anyone is paged');
