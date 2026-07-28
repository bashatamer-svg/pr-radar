// Task 16 — auth/RBAC/audit backend. HS256 tokens signed locally; Supabase +
// GoTrue + Resend mocked via globalThis.fetch. No network.
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_JWT_SECRET = 'testsecret';
process.env.RADAR_TOKEN = 'rtok';
process.env.CRON_SECRET = 'ctok';
process.env.ADMIN_EMAILS = 'boss@vodafone.com';
process.env.RADAR_FROM = 'PR Radar <x@y.com>';
process.env.RESEND_API_KEY = 'rk';
process.env.BOARD_URL = 'https://pr-radar.approvalavengers.com/';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwt(payload, { secret = 'testsecret', alg = 'HS256' } = {}) {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 10;

// ── in-memory store ──
let users = [
  { id: 1, email: 'admin@vodafone.com', role: 'admin', active: true },
  { id: 2, email: 'viewer@vodafone.com', role: 'viewer', active: true },
  { id: 3, email: 'gone@vodafone.com', role: 'viewer', active: false },
  { id: 4, email: 'signup.viewer@vodafone.com', role: 'viewer', active: true },
];
let audit = [];
let nextId = 5;
let sentEmails = [];
let authUsers = new Map(); // Supabase auth.users mock: email -> password

const qval = (u, k) => { const m = u.match(new RegExp(`${k}=eq\\.([^&]+)`)); return m ? decodeURIComponent(m[1]) : null; };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const m = opts.method || 'GET';
  const ok = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
  const nc = () => ({ ok: true, status: 204, json: async () => null, text: async () => '' });
  if (u.includes('/auth/v1/admin/generate_link')) return ok({ action_link: 'https://fake.supabase.co/auth/v1/verify?token=abc&type=magiclink&redirect_to=https://pr-radar.approvalavengers.com/' });
  if (u.includes('/auth/v1/admin/users')) {
    if (m === 'POST') {
      const b = JSON.parse(opts.body); const em = String(b.email).toLowerCase();
      if (authUsers.has(em)) return { ok: false, status: 422, json: async () => ({}), text: async () => 'User already registered' };
      authUsers.set(em, { id: 'u_' + em, password: b.password }); return ok({ id: 'u_' + em, email: em });
    }
    if (m === 'GET') { return ok({ users: [...authUsers.entries()].map(([em, v]) => ({ id: v.id, email: em })) }); }
    if (m === 'PUT') {
      const id = u.split('/auth/v1/admin/users/')[1].split('?')[0]; const b = JSON.parse(opts.body);
      for (const [, v] of authUsers) if (v.id === id) v.password = b.password;
      return ok({});
    }
  }
  if (u.includes('/auth/v1/token') && u.includes('grant_type=password') && m === 'POST') {
    const b = JSON.parse(opts.body); const em = String(b.email).toLowerCase();
    if (authUsers.get(em) && authUsers.get(em).password === b.password) return ok({ access_token: jwt({ email: em, exp: future }), refresh_token: 'r' });
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => 'invalid' };
  }
  if (u.includes('/auth/v1/user')) return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
  if (u.includes('api.resend.com/emails')) { sentEmails.push(JSON.parse(opts.body)); return ok({ id: 'e1' }); }
  if (u.includes('/rest/v1/pr_users')) {
    if (m === 'GET') {
      const em = qval(u, 'email');
      if (em) { const r = users.find((x) => x.email === em); return ok(r ? [r] : []); }
      if (u.includes('invited_by=eq.request')) return ok(users.filter((x) => x.active === false && x.invited_by === 'request'));
      return ok(users.slice());
    }
    if (m === 'POST') {
      const b = JSON.parse(opts.body); const ex = users.find((x) => x.email === b.email);
      if (ex) { Object.assign(ex, { role: b.role, name: b.name, active: true }); return ok([ex]); }
      const row = { id: nextId++, ...b }; users.push(row); return ok([row]);
    }
    if (m === 'PATCH') {
      const id = qval(u, 'id'); const em = qval(u, 'email'); const b = JSON.parse(opts.body);
      const r = users.find((x) => (id && x.id === Number(id)) || (em && x.email === em));
      if (r) Object.assign(r, b); return nc();
    }
    if (m === 'DELETE') { const id = Number(qval(u, 'id')); users = users.filter((x) => x.id !== id); return nc(); }
  }
  if (u.includes('/rest/v1/pr_audit')) {
    if (m === 'POST') { audit.push(JSON.parse(opts.body)); return nc(); }
    if (m === 'GET') {
      let rows = audit.slice();
      if (u.includes('action=eq.auth.signin_failed')) rows = rows.filter((a) => a.action === 'auth.signin_failed');
      return ok(rows.reverse());
    }
  }
  if (u.includes('/rest/v1/pr_subscribers')) { if (m === 'GET') return ok([]); return ok([{ id: 9, email: 's@x.com' }]); }
  if (u.includes('/rest/v1/pr_feedback')) { if (m === 'GET') return ok([]); return nc(); }
  if (u.includes('/rest/v1/pr_items')) return ok([]);        // itemsMissingAuthor → nothing to backfill (author sweep)
  if (u.includes('/rest/v1/pr_instances')) return ok([]);
  throw new Error('unexpected fetch ' + u + ' ' + m);
};

const auth = await import(new URL('..', import.meta.url).pathname + '/lib/auth.js');

// ── verifyHs256 ──
assert.ok(auth.verifyHs256(jwt({ email: 'a@b.com', exp: future })), 'valid HS256 verifies');
assert.strictEqual(auth.verifyHs256(jwt({ email: 'a@b.com', exp: past })), null, 'expired token rejected');
assert.strictEqual(auth.verifyHs256(jwt({ email: 'a@b.com', exp: future }, { secret: 'wrong' })), null, 'bad signature rejected');
assert.strictEqual(auth.verifyHs256('not.a.jwt'), null, 'garbage rejected');

// ── Task 3a — a valid signature alone isn't a USER. Supabase signs the anon /
// service_role API keys with the SAME jwt secret, so require role/aud = authenticated.
assert.ok(auth.verifyHs256(jwt({ email: 'a@b.com', role: 'authenticated', aud: 'authenticated', exp: future })), 'authenticated user token verifies');
assert.strictEqual(auth.verifyHs256(jwt({ role: 'anon', exp: future })), null, 'anon API key rejected (role != authenticated)');
assert.strictEqual(auth.verifyHs256(jwt({ role: 'service_role', exp: future })), null, 'service_role API key rejected');
assert.strictEqual(auth.verifyHs256(jwt({ email: 'a@b.com', role: 'authenticated', aud: 'anon', exp: future })), null, 'wrong aud rejected');
assert.ok(auth.verifyHs256(jwt({ email: 'a@b.com', role: 'authenticated', aud: ['authenticated', 'x'], exp: future })), 'aud array containing authenticated verifies');
// ── Task 3b — identity is the top-level email claim only; user_metadata is user-editable.
assert.strictEqual(await auth.verifyToken(jwt({ user_metadata: { email: 'spoof@x.com' }, role: 'authenticated', aud: 'authenticated', exp: future })), null, 'user_metadata-only email no longer authenticates');
assert.strictEqual(await auth.verifyToken(jwt({ email: 'real@b.com', role: 'authenticated', aud: 'authenticated', exp: future })), 'real@b.com', 'top-level email is the identity');

// ── roleFor (allowlist) ──
assert.strictEqual(await auth.roleFor('boss@vodafone.com'), 'admin', 'ADMIN_EMAILS → admin');
assert.strictEqual(await auth.roleFor('ADMIN@vodafone.com'), 'admin', 'pr_users admin (case-insensitive)');
assert.strictEqual(await auth.roleFor('viewer@vodafone.com'), 'viewer', 'pr_users viewer');
assert.strictEqual(await auth.roleFor('gone@vodafone.com'), null, 'inactive user blocked');
assert.strictEqual(await auth.roleFor('stranger@evil.com'), null, 'unknown email blocked');

// ── principal ──
const mkReq = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, query: {}, ...extra });
assert.strictEqual((await auth.principal(mkReq('rtok'))).role, 'viewer', 'RADAR_TOKEN (Bearer) → read-only service');
const cp = await auth.principal(mkReq('ctok'));
assert.deepStrictEqual([cp.actor, cp.role], ['service:cron', 'admin'], 'CRON_SECRET (Bearer) → service admin');
assert.strictEqual(await auth.principal({ headers: {}, query: { t: 'rtok' } }), null, 'RADAR_TOKEN in ?t= no longer authenticates');
assert.strictEqual(await auth.principal({ headers: {}, query: { t: 'ctok' } }), null, 'CRON_SECRET in ?t= no longer authenticates');
assert.ok(auth.safeEqual('abc', 'abc') && !auth.safeEqual('abc', 'abd') && !auth.safeEqual('abc', 'abcd'), 'safeEqual: equal true, unequal/length-mismatch false');
const up = await auth.principal(mkReq(jwt({ email: 'viewer@vodafone.com', exp: future })));
assert.deepStrictEqual([up.kind, up.role, up.email], ['user', 'viewer', 'viewer@vodafone.com'], 'user JWT → viewer principal');
assert.strictEqual(await auth.principal(mkReq(jwt({ email: 'stranger@evil.com', exp: future }))), null, 'valid JWT but off-allowlist → no principal');
assert.strictEqual(await auth.principal(mkReq()), null, 'no creds → null');

// ── requireRole ──
const fakeRes = () => { const r = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { this.code = this.code || 204; return this; } }; return r; };
let rs = fakeRes();
assert.strictEqual(await auth.requireRole(mkReq(), rs, 'viewer'), null); assert.strictEqual(rs.code, 401, 'no creds → 401');
rs = fakeRes();
const vp = await auth.requireRole(mkReq(jwt({ email: 'viewer@vodafone.com', exp: future })), rs, 'admin');
assert.strictEqual(vp, null); assert.strictEqual(rs.code, 403, 'viewer hitting admin → 403');
rs = fakeRes();
assert.ok(await auth.requireRole(mkReq(jwt({ email: 'admin@vodafone.com', exp: future })), rs, 'admin'), 'admin passes admin gate');

console.log('AUTH CORE OK — HS256 verify, allowlist roles, service/user principals, requireRole 401/403');

// ── api/admin RBAC + audit ──
const { default: adminHandler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const call = async (handler, { method = 'GET', query = {}, body, token } = {}) => {
  const req = { method, query, body, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = fakeRes(); await handler(req, res); return res;
};
const adminTok = jwt({ email: 'admin@vodafone.com', exp: future });
const viewerTok = jwt({ email: 'viewer@vodafone.com', exp: future });

assert.strictEqual((await call(adminHandler, { query: { view: 'users' }, token: viewerTok })).code, 403, 'viewer can\'t reach admin API');
assert.strictEqual((await call(adminHandler, { query: { view: 'users' } })).code, 401, 'no token → 401');
const list = await call(adminHandler, { query: { view: 'users' }, token: adminTok });
assert.strictEqual(list.code, 200); assert.ok(Array.isArray(list.body), 'admin lists users');

audit = [];
const add = await call(adminHandler, { method: 'POST', query: { resource: 'users' }, body: { email: 'New@Vodafone.com', role: 'viewer' }, token: adminTok });
assert.ok(add.body.ok && add.body.user.email === 'new@vodafone.com', 'admin adds a user (email lowercased)');
assert.ok(users.find((u) => u.email === 'new@vodafone.com'), 'user persisted to allowlist');
assert.ok(audit.some((a) => a.action === 'user.add' && a.actor === 'admin@vodafone.com'), 'user.add audited with actor');

// self-protection
const self = await call(adminHandler, { method: 'PATCH', query: { resource: 'users' }, body: { id: 1, active: false, email: 'admin@vodafone.com' }, token: adminTok });
assert.strictEqual(self.code, 400, 'admin cannot deactivate own account');
// role change on someone else audited
audit = [];
assert.strictEqual((await call(adminHandler, { method: 'PATCH', query: { resource: 'users' }, body: { id: 2, role: 'admin', email: 'viewer@vodafone.com' }, token: adminTok })).code, 204, 'promote viewer→admin ok');
assert.ok(audit.some((a) => a.action === 'user.role'), 'role change audited');

// admin password reset (no email): sets/creates the Supabase password, audited
audit = [];
const rpw = await call(adminHandler, { method: 'PATCH', query: { resource: 'users' }, body: { id: 2, email: 'viewer@vodafone.com', password: 'resetpass1' }, token: adminTok });
assert.strictEqual(rpw.code, 204, 'admin reset password → 204');
assert.ok(audit.some((a) => a.action === 'user.password'), 'password reset audited');
assert.strictEqual((await call(adminHandler, { method: 'PATCH', query: { resource: 'users' }, body: { id: 2, email: 'viewer@vodafone.com', password: 'short' }, token: adminTok })).code, 400, 'short reset password rejected');
console.log('ADMIN RBAC OK — admin-only, user CRUD, self-protection, admin password reset, audit rows written');

// ── admin author-backfill sweep (admin-only, returns a summary, audited) ──
// (viewer@ was promoted to admin above; new@ is a still-viewer account)
const stillViewerTok = jwt({ email: 'new@vodafone.com', exp: future });
assert.strictEqual((await call(adminHandler, { method: 'POST', query: { resource: 'backfill-authors' }, token: stillViewerTok })).code, 403, 'viewer cannot run the author backfill');
audit = [];
const sweepRes = await call(adminHandler, { method: 'POST', query: { resource: 'backfill-authors' }, body: { days: 7, limit: 40 }, token: adminTok });
assert.strictEqual(sweepRes.code, 200, 'admin runs the author backfill');
assert.ok(sweepRes.body.ok && typeof sweepRes.body.scanned === 'number' && typeof sweepRes.body.filled === 'number' && 'remaining' in sweepRes.body, 'sweep returns { scanned, filled, remaining }');
assert.ok(audit.some((a) => a.action === 'authors.backfill'), 'author backfill is audited');
console.log('ADMIN AUTHOR-BACKFILL OK — admin-only, returns scanned/filled/remaining, audited');

// ── admin WhatsApp status + test (admin-only, audited; unconfigured → safe no-op) ──
const waSt = await call(adminHandler, { query: { view: 'whatsapp-status' }, token: adminTok });
assert.strictEqual(waSt.code, 200); assert.strictEqual(waSt.body.enabled, false, 'whatsapp not configured in the test env');
assert.strictEqual((await call(adminHandler, { method: 'POST', query: { resource: 'whatsapp-test' }, token: stillViewerTok })).code, 403, 'viewer cannot send a whatsapp test');
audit = [];
const waT = await call(adminHandler, { method: 'POST', query: { resource: 'whatsapp-test' }, token: adminTok });
assert.strictEqual(waT.code, 200); assert.ok(waT.body.ok && waT.body.skipped, 'unconfigured whatsapp test is a no-op, not an error');
assert.ok(audit.some((a) => a.action === 'whatsapp.test'), 'whatsapp test audited');
console.log('ADMIN WHATSAPP OK — status + test admin-only, audited, safe no-op when unconfigured');

// ── api/auth password signup + signin ──
const { default: authHandler } = await import(new URL('..', import.meta.url).pathname + '/api/auth.js');
// signup gated by the allowlist
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signup', email: 'stranger@evil.com', password: 'longenough1' } })).code, 403, 'signup blocked for a non-allowlisted email');
// Task 1: admin emails cannot be self-claimed — provisioned server-side by ops only.
const adminSignup = await call(authHandler, { method: 'POST', body: { mode: 'signup', email: 'boss@vodafone.com', password: 'password1' } });
assert.strictEqual(adminSignup.code, 403, 'admin email cannot self-signup (provisioned server-side)');
assert.ok(/ops/i.test(adminSignup.body.error || ''), 'admin signup 403 explains ops provisioning');
assert.ok(!authUsers.has('boss@vodafone.com'), 'no Supabase account created for a blocked admin signup');
// a viewer-role allowlisted email still self-signs-up (open per project decision)
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signup', email: 'signup.viewer@vodafone.com', password: 'short' } })).code, 400, 'short password rejected');
const su = await call(authHandler, { method: 'POST', body: { mode: 'signup', email: 'signup.viewer@vodafone.com', password: 'password1' } });
assert.strictEqual(su.code, 200, 'allowlisted viewer signup succeeds');
assert.ok(su.body.access_token && su.body.role === 'viewer', 'viewer signup returns a session + role (auto sign-in, pre-confirmed, no email)');
assert.ok(authUsers.has('signup.viewer@vodafone.com'), 'viewer account created in Supabase');
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signup', email: 'signup.viewer@vodafone.com', password: 'password1' } })).code, 409, 'duplicate viewer signup → 409 (no password takeover)');
assert.ok(audit.some((a) => a.action === 'auth.signup'), 'signup audited');
// ops provisions the admin account server-side (Task 1b bootstrap), then admin signs in
authUsers.set('boss@vodafone.com', { id: 'u_boss', password: 'password1' });
// signin
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'boss@vodafone.com', password: 'wrong' } })).code, 401, 'wrong password → 401');
const si = await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'boss@vodafone.com', password: 'password1' } });
assert.strictEqual(si.code, 200, 'correct password signs in');
assert.ok(si.body.access_token && si.body.role === 'admin', 'signin returns a session + role');
// a real Supabase account that is NOT on the allowlist can authenticate but is refused the board
authUsers.set('outsider@x.com', { id: 'u_out', password: 'password9' });
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'outsider@x.com', password: 'password9' } })).code, 403, 'valid creds but off-allowlist → 403');
console.log('PASSWORD AUTH OK — allowlisted signup (pre-confirmed, no email), duplicate guard, signin, off-allowlist 403');

// ── change own password (signed-in user) ──
const cpTok = jwt({ email: 'boss@vodafone.com', exp: future });   // boss set 'password1' at signup
assert.strictEqual((await call(authHandler, { method: 'POST', token: cpTok, body: { mode: 'change_password', current: 'wrongpw', password: 'newpassword1' } })).code, 401, 'change pw: wrong current → 401');
assert.strictEqual((await call(authHandler, { method: 'POST', token: cpTok, body: { mode: 'change_password', current: 'password1', password: 'short' } })).code, 400, 'change pw: short new → 400');
assert.strictEqual((await call(authHandler, { method: 'POST', token: cpTok, body: { mode: 'change_password', current: 'password1', password: 'newpassword1' } })).code, 200, 'change pw: correct current → 200');
assert.ok(audit.some((a) => a.action === 'auth.password_change'), 'password change audited');
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'boss@vodafone.com', password: 'password1' } })).code, 401, 'old password no longer works');
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'boss@vodafone.com', password: 'newpassword1' } })).code, 200, 'new password works');
// change_password requires a signed-in user
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'change_password', current: 'x', password: 'longenough1' } })).code, 401, 'change pw without a session → 401');
console.log('CHANGE PASSWORD OK — current verified, new set, old invalidated, session required, audited');

// ── brute-force throttle on sign-in ──
audit = [];
for (let i = 0; i < 10; i++) await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'throttle@vodafone.com', password: 'wrong' + i } });
// (throttle@ isn't allowlisted, but failures are logged before the allowlist check — password grant fails first)
assert.strictEqual(audit.filter((a) => a.action === 'auth.signin_failed').length, 10, '10 failed attempts logged');
const throttled = await call(authHandler, { method: 'POST', body: { mode: 'signin', email: 'throttle@vodafone.com', password: 'again' } });
assert.strictEqual(throttled.code, 429, '11th attempt is throttled (429)');
console.log('THROTTLE OK — failed sign-ins logged; 429 after too many');

// ── access requests ──
audit = [];
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'request', email: 'Wants@Vodafone.com' } })).code, 200, 'request returns neutral 200');
const reqRow = users.find((x) => x.email === 'wants@vodafone.com');
assert.ok(reqRow && reqRow.active === false && reqRow.invited_by === 'request', 'pending request row created (inactive, marked)');
assert.ok(audit.some((a) => a.action === 'access.requested'), 'access.requested audited');
assert.strictEqual(await auth.roleFor('wants@vodafone.com'), null, 'a pending requester cannot sign in yet');
const reqList = await call(adminHandler, { query: { view: 'requests' }, token: adminTok });
assert.ok(reqList.body.some((r) => r.email === 'wants@vodafone.com'), 'request appears in the admin requests view');
audit = [];
assert.strictEqual((await call(adminHandler, { method: 'PATCH', query: { resource: 'requests' }, body: { id: reqRow.id, email: 'wants@vodafone.com', role: 'viewer' }, token: adminTok })).code, 204, 'approve → 204');
assert.strictEqual(users.find((x) => x.id === reqRow.id).active, true, 'approved requester becomes active');
assert.strictEqual(await auth.roleFor('wants@vodafone.com'), 'viewer', 'approved requester can now be authorised');
assert.ok(audit.some((a) => a.action === 'access.approve'), 'approval audited');
await call(authHandler, { method: 'POST', body: { mode: 'request', email: 'nope@x.com' } });
const rej = users.find((x) => x.email === 'nope@x.com');
audit = [];
assert.strictEqual((await call(adminHandler, { method: 'DELETE', query: { resource: 'requests', id: rej.id, email: 'nope@x.com' }, token: adminTok })).code, 204, 'reject → 204');
assert.ok(!users.find((x) => x.email === 'nope@x.com'), 'rejected request removed');
assert.ok(audit.some((a) => a.action === 'access.reject'), 'rejection audited');
console.log('ACCESS REQUEST OK — pending row created, admin approve/reject, audited');

// ── optional magic-link fallback still works (mode:magiclink) ──
sentEmails = [];
await call(authHandler, { method: 'POST', body: { mode: 'magiclink', email: 'stranger@evil.com' } });
assert.strictEqual(sentEmails.length, 0, 'no link emailed to a stranger');
await call(authHandler, { method: 'POST', body: { mode: 'magiclink', email: 'boss@vodafone.com' } });
assert.strictEqual(sentEmails.length, 1, 'magic-link fallback still emails an allowlisted address');
assert.ok(sentEmails[0].to.includes('boss@vodafone.com') && /Sign in/.test(sentEmails[0].subject), 'branded sign-in email to the right address');
// the visible link is on OUR domain, and the raw supabase host is NOT in the href
assert.ok(sentEmails[0].html.includes('https://pr-radar.approvalavengers.com/auth/verify?u='), 'email link points at our own /auth/verify hop');
assert.ok(!/href="[^"]*fake\.supabase\.co/.test(sentEmails[0].html), 'raw supabase host is not the clickable href');

// verify hop redirects to the real supabase link, and refuses anything else
const { default: verifyHandler } = await import(new URL('..', import.meta.url).pathname + '/api/verify.js');
const b64u = (s) => Buffer.from(s, "utf8").toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const vcall = (uParam) => { let code, headers = {}, body; const res = { status(c) { code = c; return res; }, send(b) { body = b; return res; }, writeHead(c, h) { code = c; headers = h; return res; }, end() { return res; } }; verifyHandler({ query: { u: uParam } }, res); return { code, headers, body }; };
const good = 'https://fake.supabase.co/auth/v1/verify?token=abc&redirect_to=https://pr-radar.approvalavengers.com/';
const vr = vcall(b64u(good));
assert.strictEqual(vr.code, 302, 'verify hop 302-redirects a valid project link');
assert.strictEqual(vr.headers.Location, good, 'redirects to the exact supabase verify URL');
assert.strictEqual(vcall(b64u('https://evil.com/auth/steal')).code, 400, 'open-redirect to another host is refused');
assert.strictEqual(vcall(b64u('https://fake.supabase.co/not-auth/x')).code, 400, 'non-/auth path refused');
assert.strictEqual(vcall('!!!not-base64').code, 400, 'malformed token refused');
console.log('BRANDED LINK OK — email links to our domain; verify hop redirects only to this project, guards open-redirect');
// magic-link mode stays neutral for a stranger (no enumeration)
assert.strictEqual((await call(authHandler, { method: 'POST', body: { mode: 'magiclink', email: 'stranger@evil.com' } })).code, 200, 'magic-link neutral 200 for stranger');
// me — use a still-viewer account (viewer@ was promoted to admin above)
const freshViewerTok = jwt({ email: 'new@vodafone.com', exp: future });
const me = await call(authHandler, { query: { view: 'me' }, token: freshViewerTok });
assert.deepStrictEqual([me.code, me.body.role], [200, 'viewer'], 'view=me returns identity');
assert.strictEqual((await call(authHandler, { query: { view: 'me' } })).code, 401, 'view=me without session → 401');

console.log('AUTH ENDPOINT OK — password signup/signin + magic-link fallback, view=me identity');
console.log('ALL TASK 16 BACKEND TESTS PASSED');
