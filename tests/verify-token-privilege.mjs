// RADAR_TOKEN is READ-ONLY. CRON_SECRET operates.
//
// lib/auth.js has said so since the roles were introduced — `principal()` maps
// CRON_SECRET to admin and RADAR_TOKEN to viewer — but /api/radar and /api/geo
// each carried their OWN inline `safeEqual` pair that accepted either token.
// So the shared read token could fire a full ingest: thirty feed fetches, a
// round of paid classifier calls, the daily brief to every subscriber, and the
// WhatsApp crisis numbers. Two authorization implementations is also how a
// policy drifts — those two endpoints never heard that the model had tightened.
//
// This pins the table in lib/auth.js end to end, per principal and per
// endpoint, INCLUDING the must-not cases (which are the whole point).
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.CRON_SECRET = 'cron-operator-secret';
process.env.RADAR_TOKEN = 'radar-read-token';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
process.env.ADMIN_EMAILS = 'boss@vodafone.com';
process.env.GEO_ENABLED = '';           // geo stays dark; we only test the gate

// A real HS256 session token, so the signed-in cases go through the actual
// verification rather than a stub of it.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sessionFor(email) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

// The allowlist: one admin (via ADMIN_EMAILS) and one plain viewer (via pr_users).
const VIEWER = 'reader@vodafone.com';
let ingested = false, sent = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/rest/v1/pr_users')) {
    // lib/db.js rest() reads .text() and JSON.parses it — mock that, not .json().
    const hit = u.includes(encodeURIComponent(VIEWER)) || u.includes(VIEWER);
    const rows = hit ? [{ id: 1, email: VIEWER, role: 'viewer', active: true }] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  }
  if (u.includes('/rest/v1/pr_audit')) return { ok: true, status: 200, text: async () => '', json: async () => null };
  if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  if (u.includes('api.resend.com')) { sent = true; return { ok: true, status: 200, text: async () => '{}', json: async () => ({ id: 'm' }) }; }
  // ANY outbound feed fetch means the pipeline started running, which is
  // exactly what an unauthorised caller must never manage to cause.
  ingested = true;
  throw new Error('network blocked in test');
};

const { requireOperator, principal } = await import('../lib/auth.js');
const { default: radar } = await import('../api/radar.js');
const { default: geo } = await import('../api/geo.js');

function fakeRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}
const AS = {
  cron: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  radarToken: { authorization: `Bearer ${process.env.RADAR_TOKEN}` },
  admin: { authorization: `Bearer ${sessionFor('boss@vodafone.com')}` },
  viewer: { authorization: `Bearer ${sessionFor(VIEWER)}` },
  none: {},
};

// ── 1. principal() maps each bearer to the role the model claims ───────────
{
  const p = await principal({ headers: AS.cron });
  assert.deepStrictEqual({ kind: p.kind, role: p.role }, { kind: 'service', role: 'admin' }, 'CRON_SECRET is a service OPERATOR');
}
{
  const p = await principal({ headers: AS.radarToken });
  assert.deepStrictEqual({ kind: p.kind, role: p.role }, { kind: 'service', role: 'viewer' },
    'RADAR_TOKEN is a service VIEWER — read-only, and that is the whole point');
}
{
  assert.strictEqual((await principal({ headers: AS.admin })).role, 'admin', 'a signed-in allowlisted admin is admin');
  assert.strictEqual((await principal({ headers: AS.viewer })).role, 'viewer', 'a signed-in ordinary user is viewer');
  assert.strictEqual(await principal({ headers: AS.none }), null, 'no bearer is nobody');
  assert.strictEqual(await principal({ headers: { authorization: 'Bearer wrong' } }), null, 'a wrong token is nobody');
}

// ── 2. requireOperator accepts operators and refuses readers ───────────────
for (const [name, headers, want] of [
  ['cron', AS.cron, 200], ['signed-in admin', AS.admin, 200],
  ['RADAR_TOKEN', AS.radarToken, 403], ['signed-in viewer', AS.viewer, 403],
  ['nobody', AS.none, 401],
]) {
  const res = fakeRes();
  const who = await requireOperator({ headers }, res);
  if (want === 200) assert.ok(who, `requireOperator lets ${name} through`);
  else {
    assert.strictEqual(who, null, `requireOperator refuses ${name}`);
    assert.strictEqual(res.code, want, `${name} gets ${want} (got ${res.code})`);
  }
}

// ── 3. /api/radar — the endpoint that ingests, mails and pages ─────────────
// Every refusal must happen BEFORE any work: no feed fetched, no mail sent.
for (const [name, headers, want] of [
  ['RADAR_TOKEN', AS.radarToken, 403],
  ['a signed-in viewer', AS.viewer, 403],
  ['no bearer at all', AS.none, 401],
]) {
  for (const query of [{}, { dry: '1' }, { urgentOnly: '1' }, { debug: '1' }, { backfillAuthors: '1' }, { to: 'x@y.com' }]) {
    ingested = false; sent = false;
    const res = fakeRes();
    await radar({ method: 'GET', query, headers }, res);
    const q = JSON.stringify(query);
    assert.strictEqual(res.code, want, `/api/radar ${q} refuses ${name} with ${want} (got ${res.code})`);
    // ?dry=1 stores nothing — but it still fetches thirty feeds and pays for a
    // round of classifier calls, so a READ token must not be able to run it.
    assert.strictEqual(ingested, false, `/api/radar ${q} did no work for ${name}`);
    assert.strictEqual(sent, false, `/api/radar ${q} sent nothing for ${name}`);
  }
}
// And the operators DO get past the gate. The run then dies on the blocked
// network, which is fine — reaching the feed fetch is proof the gate opened.
for (const [name, headers] of [['cron', AS.cron], ['a signed-in admin', AS.admin]]) {
  ingested = false;
  const res = fakeRes();
  await radar({ method: 'GET', query: { dry: '1' }, headers }, res).catch(() => {});
  assert.notStrictEqual(res.code, 401, `${name} is not challenged by /api/radar`);
  assert.notStrictEqual(res.code, 403, `${name} is not forbidden by /api/radar`);
  assert.ok(ingested, `${name} got as far as fetching feeds`);
}

// ── 4. /api/geo — same rule ────────────────────────────────────────────────
for (const [name, headers, want] of [
  ['RADAR_TOKEN', AS.radarToken, 403], ['a signed-in viewer', AS.viewer, 403], ['nobody', AS.none, 401],
]) {
  const res = fakeRes();
  await geo({ method: 'GET', query: { send: '1' }, headers }, res);
  assert.strictEqual(res.code, want, `/api/geo refuses ${name} with ${want} (got ${res.code})`);
  assert.strictEqual(sent, false, `/api/geo mailed nothing for ${name}`);
}
{
  const res = fakeRes();
  await geo({ method: 'GET', query: {}, headers: AS.cron }, res);
  assert.strictEqual(res.code, 200, `cron may run /api/geo (got ${res.code})`);
}

// ── 5. RADAR_TOKEN keeps the READ APIs it exists for ───────────────────────
// The point is least privilege, not revocation: a change that quietly broke the
// read token would break whatever machine holds it.
{
  const { default: stats } = await import('../api/stats.js');
  const res = fakeRes();
  await stats({ method: 'GET', query: { days: '7' }, headers: AS.radarToken }, res);
  assert.strictEqual(res.code, 200, `RADAR_TOKEN can still read /api/stats (got ${res.code})`);
  assert.ok(res.body && res.body.totals, 'and gets real aggregate data back');
}
{
  const { default: items } = await import('../api/items.js');
  const res = fakeRes();
  await items({ method: 'GET', query: {}, headers: AS.radarToken }, res);
  assert.strictEqual(res.code, 200, `RADAR_TOKEN can still read /api/items (got ${res.code})`);
  // …but not WRITE through it.
  const w = fakeRes();
  await items({ method: 'PATCH', query: {}, body: { id: 1, team_share: true }, headers: AS.radarToken }, w);
  assert.strictEqual(w.code, 403, `RADAR_TOKEN cannot PATCH an item (got ${w.code})`);
}

// ── 6. no endpoint may re-grow its own token check ─────────────────────────
// Both drifting endpoints had an inline `safeEqual(bearer, RADAR_TOKEN)` pair.
// Authorization decisions belong to lib/auth.js and nowhere else.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  for (const f of readdirSync(root + 'api').filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(`${root}api/${f}`, 'utf8');
    assert.ok(!/process\.env\.RADAR_TOKEN/.test(src),
      `api/${f} reads RADAR_TOKEN directly — authorize through lib/auth.js instead`);
    assert.ok(!/safeEqual\s*\([^)]*CRON_SECRET/.test(src),
      `api/${f} compares CRON_SECRET inline — use requireOperator/requireRole`);
  }
}

console.log('TOKEN-PRIVILEGE OK — RADAR_TOKEN reads and cannot ingest, classify, mail or page; CRON_SECRET and signed-in admins operate; signed-in viewers cannot; no endpoint carries its own token check');
