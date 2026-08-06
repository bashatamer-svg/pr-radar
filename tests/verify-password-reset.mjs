// "Forgot password?" — the request reaches an admin, and reveals nothing.
//
// The link used to print advice ("an admin can reset it from Admin → Users") and
// send NOTHING: a locked-out person had to know which admin to chase, and the
// admin never learned anyone was waiting. It now flags pr_users, emails an admin
// and shows in Admin → Requests until a password is set.
//
// What must hold, hardest first:
//   1. the answer is IDENTICAL for a real account and an unknown address — a
//      sign-in screen that says "no such user" is an access directory
//   2. only a REAL account triggers mail, or the form sprays the ops inbox
//   3. it never CREATES an account as a side effect
//   4. setting a password (admin reset, self-service change) clears the request,
//      so the queue empties itself
//   5. with the migration UNAPPLIED nothing 500s — the feature is absent, not
//      broken, because the code ships before the SQL is run by hand
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.CRON_SECRET = 'admin';
process.env.ADMIN_EMAILS = 'boss@vodafone.com';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
process.env.RESEND_API_KEY = 'resend-key';
process.env.RADAR_FROM = 'PR Radar <radar@example.com>';
process.env.BOARD_URL = 'https://pr-radar.example.com/';
// Deliberately UNSET, exactly as production is: the alert has to find an admin
// anyway, or a locked-out colleague waits on a reply that was never sent.
delete process.env.OPS_ALERT_TO;
delete process.env.RADAR_TO;

const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

// A real HS256 session, signed with the secret lib/auth.js verifies against.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sessionFor = (email) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const pl = b64({ email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${pl}.${crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(`${h}.${pl}`).digest('base64url')}`;
};

let world = {};
// `column` false simulates the migration NOT being applied: PostgREST answers
// 42703 for a column that does not exist.
function reset({ known = true, active = true, column = true } = {}) {
  world = { known, active, column, patched: [], created: [], audits: [], sent: [], alerts: [] };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (u.includes('/rest/v1/pr_users')) {
    const touchesColumn = /reset_requested_at/.test(u) || (body && 'reset_requested_at' in body);
    if (touchesColumn && !world.column) {
      return { ok: false, status: 400, text: async () => '{"code":"42703","message":"column pr_users.reset_requested_at does not exist"}' };
    }
    if (m === 'PATCH') {
      world.patched.push({ u, body });
      // A PATCH filtered by email only matches when the row exists AND is active.
      const matched = world.known && (!/active=is\.true/.test(u) || world.active);
      return ok(JSON.stringify(matched ? [{ id: 4, email: 'mona.said@vodafone.com' }] : []));
    }
    if (m === 'POST') { world.created.push(body); return ok(JSON.stringify([{ id: 9, ...body }])); }
    if (/reset_requested_at=not\.is\.null/.test(u)) {
      // The queue, oldest first — two people waiting.
      return ok(JSON.stringify([
        { id: 4, email: 'mona.said@vodafone.com', name: 'Mona Said', role: 'viewer', reset_requested_at: '2026-08-05T09:00:00Z' },
        { id: 7, email: 'sara@vodafone.com', name: 'Sara', role: 'viewer', reset_requested_at: '2026-08-06T07:00:00Z' },
      ]));
    }
    // getUserByEmail / listUsers
    if (/select=id,email,role,active/.test(u)) return ok(JSON.stringify(world.known ? [{ id: 4, email: 'mona.said@vodafone.com', role: 'viewer', active: world.active }] : []));
    return ok('[]');
  }
  if (u.includes('/rest/v1/pr_audit')) { world.audits.push(body); return ok(''); }
  if (u.includes('/rest/v1/pr_alerts')) { world.alerts.push(body); return ok(''); }
  if (u.includes('/auth/v1/admin/users')) { return ok(JSON.stringify({ id: 'uid', email: 'x' })); }
  if (u.includes('/auth/v1/token')) return ok(JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
  if (u.includes('api.resend.com')) { world.sent.push(body); return ok(JSON.stringify({ id: 'mail' })); }
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const ROOT = new URL('..', import.meta.url).pathname;
const { default: auth } = await import(ROOT + 'api/auth.js');
const { default: admin } = await import(ROOT + 'api/admin.js');

const call = async (handler, req) => {
  let code, out;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() { code = code || 204; return res; } };
  await handler(req, res);
  return { code, out };
};
const askReset = (email) => call(auth, { method: 'POST', query: {}, body: { mode: 'reset_request', email }, headers: {} });

/* ── 1. a real, active account ────────────────────────────────────────────── */
reset({ known: true });
let { code, out } = await askReset('mona.said@vodafone.com');
assert.strictEqual(code, 200, `answers 200 (got ${code})`);
assert.deepStrictEqual(out, { ok: true }, 'and says nothing about the account');
const flag = world.patched.find((p) => p.body && p.body.reset_requested_at);
assert.ok(flag, 'the request is recorded on pr_users');
assert.ok(/email=eq\.mona\.said%40vodafone\.com/.test(flag.u), 'against that address');
assert.ok(/active=is\.true/.test(flag.u), 'and only for an ACTIVE row — a blocked user is not a reset candidate');
assert.strictEqual(world.created.length, 0, 'no account is created as a side effect');
// The admin hears about it. Both env vars are unset here, as in production, so
// this only works because the caller names ADMIN_EMAILS.
assert.strictEqual(world.sent.length, 1, 'an admin is emailed');
assert.deepStrictEqual(world.sent[0].to, ['boss@vodafone.com'], 'namely ADMIN_EMAILS, since OPS_ALERT_TO and RADAR_TO are unset');
assert.ok(/mona\.said@vodafone\.com/.test(world.sent[0].html), 'the mail names who is waiting');
assert.ok(/Reset password/i.test(world.sent[0].html), 'and what to do about it');
assert.strictEqual(world.alerts.length, 1, 'and it is recorded in the alert history');
const aud = world.audits.find((a) => a.action === 'auth.reset_requested');
assert.ok(aud, 'the request is audited');
assert.strictEqual(aud.detail.known, true, 'noting that it matched a real account');

/* ── 2. an address with no account: byte-identical answer ─────────────────── */
reset({ known: false });
const unknown = await askReset('stranger@example.com');
assert.strictEqual(unknown.code, 200, 'an unknown address answers 200 too');
assert.deepStrictEqual(unknown.out, out, 'with the SAME body — the screen cannot be used to enumerate accounts');
assert.strictEqual(world.sent.length, 0, 'and mails nobody, so the form cannot spray the ops inbox');
assert.strictEqual(world.created.length, 0, 'and still creates nothing');
const aud2 = world.audits.find((a) => a.action === 'auth.reset_requested');
assert.strictEqual(aud2.detail.known, false, 'the audit records that it matched nothing — visible to ops, not to the browser');

/* ── 3. a BLOCKED account is not a reset candidate ───────────────────────── */
reset({ known: true, active: false });
const blocked = await askReset('mona.said@vodafone.com');
assert.deepStrictEqual(blocked.out, out, 'same neutral answer');
assert.strictEqual(world.sent.length, 0, 'but no admin is paged about someone deliberately switched off');

/* ── 4. the queue an admin sees ───────────────────────────────────────────── */
reset();
({ code, out } = await call(admin, { method: 'GET', query: { view: 'resets' }, headers: { authorization: 'Bearer admin' } }));
assert.strictEqual(code, 200, 'the queue is readable');
assert.strictEqual(out.length, 2, 'both waiting people are listed');
assert.strictEqual(out[0].email, 'mona.said@vodafone.com', 'oldest first — longest locked out is served next');
assert.ok(!('password_hash' in out[0]) && !('reset_token' in out[0]), 'and it carries no credential material');

/* ── 5. setting a password ANSWERS the request ────────────────────────────── */
reset();
({ code } = await call(admin, {
  method: 'PATCH', query: { resource: 'users' },
  body: { id: 4, email: 'mona.said@vodafone.com', password: 'a-strong-temp-1' },
  headers: { authorization: 'Bearer admin' },
}));
assert.strictEqual(code, 204, `the admin reset succeeds (got ${code})`);
const cleared = world.patched.find((p) => p.body && p.body.reset_requested_at === null);
assert.ok(cleared, 'and clears the outstanding request, so the queue empties itself');
assert.ok(/email=eq\.mona\.said%40vodafone\.com/.test(cleared.u), 'for that person');

/* ── 6. …and so does the user changing it themselves ──────────────────────── */
// Someone who gets back in on their own must not still sit in the admin's queue.
// Driven through the REAL signed-in path: a service token has no email of its
// own, so authenticating as CRON_SECRET here would prove nothing.
reset();
({ code, out } = await call(auth, {
  method: 'POST', query: {},
  body: { mode: 'change_password', current: 'old-one', password: 'brand-new-one' },
  headers: { authorization: `Bearer ${sessionFor('boss@vodafone.com')}` },
}));
assert.strictEqual(code, 200, `a signed-in user can change their own password (got ${code} ${JSON.stringify(out)})`);
const selfCleared = world.patched.find((p) => p.body && p.body.reset_requested_at === null);
assert.ok(selfCleared, 'and that clears their outstanding request too');
assert.ok(/email=eq\.boss%40vodafone\.com/.test(selfCleared.u), 'for their own address');

/* ── 7. dismissing a request changes no password ──────────────────────────── */
reset();
({ code } = await call(admin, {
  method: 'DELETE', query: { resource: 'resets', id: '4', email: 'mona.said@vodafone.com' },
  headers: { authorization: 'Bearer admin' },
}));
assert.strictEqual(code, 204, 'dismiss succeeds');
assert.ok(world.patched.some((p) => p.body && p.body.reset_requested_at === null), 'the flag is cleared');
assert.strictEqual(world.patched.filter((p) => p.body && 'password' in p.body).length, 0, 'and nothing touches the password');
assert.ok(world.audits.some((a) => a.action === 'user.reset_dismissed'), 'the dismissal is audited — it leaves someone locked out');

/* ── 8. THE MIGRATION IS NOT APPLIED YET ─────────────────────────────────── */
// The code ships before the SQL is run by hand, so every path must degrade
// rather than error. A 500 on the sign-in screen would be the worst possible
// place for this to surface.
reset({ column: false });
const noCol = await askReset('mona.said@vodafone.com');
assert.strictEqual(noCol.code, 200, 'the sign-in screen still answers 200 with no column');
assert.deepStrictEqual(noCol.out, { ok: true }, 'with the same neutral body');
assert.strictEqual(world.sent.length, 0, 'nothing could be recorded, so nobody is told a request is queued');

reset({ column: false });
({ code, out } = await call(admin, { method: 'GET', query: { view: 'resets' }, headers: { authorization: 'Bearer admin' } }));
assert.strictEqual(code, 200, 'the admin queue still renders');
assert.deepStrictEqual(out, [], 'as empty');

// And the Users tab — the one that would take the whole page down, since a
// select naming a missing column 400s the entire request.
reset({ column: false });
({ code, out } = await call(admin, { method: 'GET', query: { view: 'users' }, headers: { authorization: 'Bearer admin' } }));
assert.strictEqual(code, 200, `the users list survives a missing column (got ${code})`);
assert.ok(Array.isArray(out), 'and still returns rows');

console.log('PASSWORD-RESET OK — "Forgot password?" flags the account, emails an admin (ADMIN_EMAILS, since OPS_ALERT_TO/RADAR_TO are unset in production) and queues in Admin → Requests; the answer is byte-identical for an unknown address and no account is ever created; a blocked user pages nobody; setting or dismissing clears the request and dismissal is audited; and with the migration unapplied every path degrades to absent rather than erroring');
