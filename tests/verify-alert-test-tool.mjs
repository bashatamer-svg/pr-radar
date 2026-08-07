// Admin → Tools → "Send test to myself": prove the EMAIL alert path from
// production, where the sandbox cannot reach Resend.
//
// The existing whatsapp-test only exercises the WhatsApp channel, which is
// blocked on Meta's template approval — so the channel that actually works had
// no way to be checked outside the unit tests.
//
// The load-bearing property: a delivery test must reach the requesting admin
// and NOBODY else. Paging two subscribers because someone clicked "test" is the
// exact failure that makes people stop clicking it.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RESEND_API_KEY = 're_x';
process.env.RADAR_FROM = 'radar@example.com';
// Set, and pointed somewhere else entirely: the test must not fall back to it.
process.env.RADAR_TO = 'thewholeteam@example.com';

const ADMIN = 'boss@vodafone.com';

let sent = [];
let audits = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

  // requireRole resolves the bearer to a user row.
  if (u.includes('/rest/v1/pr_users')) return ok(JSON.stringify([{ email: ADMIN, role: 'admin', active: true }]));
  if (u.includes('/rest/v1/pr_audit') && m === 'POST') { audits.push(JSON.parse(opts.body)); return ok(''); }
  if (u.includes('/rest/v1/pr_subscribers')) return ok(JSON.stringify([{ email: 'sub1@example.com' }, { email: 'sub2@example.com' }]));
  if (u.includes('api.resend.com') && m === 'POST') { sent.push(JSON.parse(opts.body)); return ok('{"id":"em_1"}'); }
  if (u.includes('/rest/v1/')) return ok('[]');
  if (u.includes('auth/v1')) return ok(JSON.stringify({ email: ADMIN }));
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const call = async (body) => {
  let code, out;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({
    method: 'POST', query: { resource: 'alert-test' }, body,
    headers: { authorization: `Bearer admin` },
  }, res);
  return { code, out };
};

// The CRON_SECRET bearer is a SERVICE identity with no address of its own —
// it must be refused rather than silently falling back to RADAR_TO.
{
  const { code, out } = await call({ impact: 5 });
  assert.strictEqual(code, 400, `a service token has no address to test with (got ${code} ${JSON.stringify(out)})`);
  assert.strictEqual(sent.length, 0, 'and nothing was sent');
}

// Now as a signed-in human: a Supabase JWT bearer resolves through pr_users,
// which the mock above answers with an admin row carrying ADMIN's address.
{
  sent = []; audits = [];
  let code, out;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({
    method: 'POST', query: { resource: 'alert-test' }, body: { impact: 5 },
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImJvc3NAdm9kYWZvbmUuY29tIn0.x' },
  }, res);

  assert.strictEqual(code, 200, `the signed-in admin can send a test (got ${code} ${JSON.stringify(out)})`);
  assert.strictEqual(sent.length, 1, `exactly one email (sent ${sent.length})`);
  const to = [].concat(sent[0].to || []).map(String);
  // THE point of this test.
  assert.deepStrictEqual(to, [ADMIN], `the test goes only to the requesting admin (got ${JSON.stringify(to)})`);
  assert.ok(!to.some((a) => /sub1|sub2|thewholeteam/.test(a)), 'never the subscriber list, never RADAR_TO');
  assert.ok(/^URGENT — /.test(sent[0].subject), `Impact 5 is subjected URGENT (got ${sent[0].subject})`);
  // The badge lost its ● bullet in the 2026-08 redesign; match the pill.
  assert.ok(/letter-spacing:\.28em;[^"]*">URGENT<\/span>/.test(sent[0].html), 'and badged URGENT in the body');
  assert.ok(/please ignore/i.test(sent[0].subject), 'the subject says it is a test, so a recipient does not act on it');
  assert.ok(audits.some((a) => JSON.stringify(a).includes('alert.test')), 'the send is audited');

  // The lower tier renders as ALERT, so the picker actually previews something
  // different rather than sending the same mail three ways.
  sent = [];
  const res2 = { status: () => res2, json: () => res2, setHeader() {}, end() {} };
  await handler({
    method: 'POST', query: { resource: 'alert-test' }, body: { impact: 2 },
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImJvc3NAdm9kYWZvbmUuY29tIn0.x' },
  }, res2);
  assert.strictEqual(sent.length, 1, 'the Impact-2 sample also sends');
  assert.ok(/^ALERT — /.test(sent[0].subject), `a Vodafone negative at Impact 2 is subjected ALERT (got ${sent[0].subject})`);
  assert.ok(!/severity-5/.test(sent[0].html), 'and is not described as a severity-5 threat');
}

console.log(`ALERT-TEST-TOOL OK — the email delivery test reaches only the signed-in admin (${ADMIN}), never the subscriber list or RADAR_TO, is audited, and previews the real URGENT/ALERT tiering`);
