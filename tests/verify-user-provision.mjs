// Admin → Users → "Add a user" provisions a PERSON, not just an allowlist row.
//
// An allowlist entry on its own left the new user stuck: they had to work out
// that they could now "Create account" on the login screen, and an admin could
// not even do that (self-signup refuses role=admin, deliberately). So adding
// someone now sets a starter password (first name + 123), optionally puts them
// on the daily brief, and emails them their own sign-in.
//
// What must hold, in order of how much a mistake would cost:
//   1. an EXISTING password is never reset, and never mailed out again
//   2. an existing SUBSCRIBER row is never overwritten (that would wipe the
//      WhatsApp crisis number and the category filter)
//   3. the password reaches the admin in the response but NEVER the audit log
//   4. the welcome email carries that person's own address + password, no token
//   5. every step is reported separately, so a failed send can't read as clean
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.CRON_SECRET = 'admin';
process.env.ADMIN_EMAILS = 'boss@vodafone.com';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
process.env.RESEND_API_KEY = 'resend-key';
process.env.RADAR_FROM = 'PR Radar <radar@example.com>';
process.env.BOARD_URL = 'https://pr-radar.example.com/';
process.env.RADAR_TOKEN = 'SEKRIT-TOKEN-123';

const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

// A real HS256 session token, signed with the same secret lib/auth.js verifies
// against — so the signed-in path below goes through the actual verification
// rather than a stub of it.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sessionFor(email) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

// ── the fake world ──────────────────────────────────────────────────────────
let world = {};
function reset({ authExists = false, subscriber = null } = {}) {
  world = {
    authExists, subscriber,
    users: [], created: [], subsPosted: [], subsPatched: [], audits: [], sent: [],
    subsGetUrls: [],
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;

  // Supabase Auth admin — CREATE ONLY. 422 when the account already exists.
  if (u.includes('/auth/v1/admin/users') && m === 'POST') {
    if (world.authExists) return { ok: false, status: 422, text: async () => '{"msg":"User already registered"}' };
    world.created.push(body);
    return ok(JSON.stringify({ id: 'uid-1', email: body.email }));
  }
  // A PUT here would mean an existing password was overwritten — the one thing
  // provisioning must never do.
  if (u.includes('/auth/v1/admin/users') && m === 'PUT') {
    throw new Error('provisioning must never PUT a password onto an existing account');
  }
  if (u.includes('/auth/v1/admin/users')) return ok('{"users":[]}');

  if (u.includes('/rest/v1/pr_users') && m === 'POST') {
    const row = { id: 7, ...body, created_at: '2026-08-06T00:00:00Z' };
    world.users.push(row);
    return ok(JSON.stringify([row]));
  }
  if (u.includes('/rest/v1/pr_subscribers') && m === 'POST') { world.subsPosted.push(body); return ok(JSON.stringify([{ id: 3, ...body }])); }
  if (u.includes('/rest/v1/pr_subscribers') && m === 'PATCH') { world.subsPatched.push({ u, body }); return ok(''); }
  if (u.includes('/rest/v1/pr_subscribers')) {
    world.subsGetUrls.push(u);
    return ok(JSON.stringify(world.subscriber ? [world.subscriber] : []));
  }
  if (u.includes('/rest/v1/pr_audit')) { world.audits.push(body); return ok(''); }
  if (u.includes('api.resend.com')) { world.sent.push(body); return ok(JSON.stringify({ id: 'mail-1' })); }
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
// `as` picks the PRINCIPAL. It matters more than it looks: the cron token is a
// service principal with no email of its own, so every BCC and support-address
// branch is dead under it — which is why the BCC went untested at first.
// A signed-in admin is what the browser actually sends.
const CRON = { authorization: 'Bearer admin' };
const SIGNED_IN = { authorization: `Bearer ${sessionFor('boss@vodafone.com')}` };
async function addUser(body, as = CRON) {
  let code, out;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end() { } };
  await handler({ method: 'POST', query: { resource: 'users' }, body, headers: as }, res);
  return { code, out };
}

/* ── 1. the ordinary case: new person, brief on, email on ─────────────────── */
reset();
let { code, out } = await addUser({ email: 'Tamer.Basha@vodafone.com', name: 'Tamer Basha', role: 'viewer' });
assert.strictEqual(code, 200, `add succeeds (got ${code} ${JSON.stringify(out)})`);
assert.strictEqual(out.credentials, 'created', 'a starter password was set');
assert.strictEqual(out.password, 'tamer123', `the convention is first name + 123 (got ${out.password})`);
assert.strictEqual(world.created.length, 1, 'exactly one auth account created');
assert.strictEqual(world.created[0].password, 'tamer123', 'and it carries that password');
assert.strictEqual(world.created[0].email, 'tamer.basha@vodafone.com', 'lower-cased, so it matches the allowlist row');
assert.strictEqual(world.created[0].email_confirm, true, 'pre-confirmed — no confirmation email to chase');
assert.strictEqual(world.users.length, 1, 'the allowlist row is written');
assert.strictEqual(world.users[0].role, 'viewer', 'with the requested role');

// Daily brief, default ON.
assert.strictEqual(out.subscriber, 'added', `subscribed by default (got ${out.subscriber})`);
assert.strictEqual(world.subsPosted.length, 1, 'one subscriber row added');
assert.strictEqual(world.subsPosted[0].email, 'tamer.basha@vodafone.com', 'for that address');
assert.strictEqual(world.subsPosted[0].active, true, 'active, so the brief actually reaches them');

// The welcome email: to THEM, their own credentials, admin BCC'd, no token.
assert.strictEqual(out.emailed, true, 'the welcome email was sent');
assert.strictEqual(world.sent.length, 1, 'exactly one message');
assert.deepStrictEqual(world.sent[0].to, ['tamer.basha@vodafone.com'], 'addressed to the new user alone');
assert.match(world.sent[0].subject, /PR Radar sign-in/, `subject names what it is (got "${world.sent[0].subject}")`);
const html = world.sent[0].html;
assert.ok(html.includes('tamer123'), 'the email states the starter password');
assert.ok(html.includes('tamer.basha@vodafone.com'), 'and the address to use');
assert.ok(/Hi Tamer,/.test(html), 'greeted by first name');
assert.ok(html.includes('https://pr-radar.example.com/login'), 'with a sign-in link to the board');
assert.ok(/Change that password/i.test(html), 'and tells them to change it');
assert.ok(/daily brief/i.test(html), 'a subscribed person is told the brief is coming');
// Same rule as every other PR Radar email: no credential in a URL.
assert.ok(!html.includes(process.env.RADAR_TOKEN), 'no service token in the welcome email');
assert.ok(!/[?&]t=/.test(html), 'no ?t= token param');
// Style attributes are double-quoted, so a double quote inside one truncates it.
assert.ok(!html.includes('"Segoe UI"'), 'font stack uses single quotes inside style attributes');

// 3. THE PASSWORD MUST NOT BE STORED. The response is transient and goes to the
//    admin who asked; an audit row lives in the database for ever.
assert.ok(world.audits.length >= 1, 'the add is audited');
for (const a of world.audits) {
  assert.ok(!JSON.stringify(a).includes('tamer123'), 'no audit row records the password');
}
const add = world.audits.find((a) => a.action === 'user.add');
assert.ok(add, 'audited as user.add');
assert.deepStrictEqual(
  { credentials: add.detail.credentials, subscriber: add.detail.subscriber, emailed: add.detail.emailed },
  { credentials: 'created', subscriber: 'added', emailed: true },
  'the audit records what each step did',
);

/* ── 2. subscribe:false — the option the whole feature is about ───────────── */
reset();
({ out } = await addUser({ email: 'quiet@vodafone.com', name: 'Quiet Person', role: 'viewer', subscribe: false }));
assert.strictEqual(out.subscriber, 'skipped', 'not subscribed when the box is unticked');
assert.strictEqual(world.subsPosted.length, 0, 'no subscriber row written');
assert.strictEqual(out.credentials, 'created', 'they still get a sign-in');
assert.strictEqual(out.emailed, true, 'and still get told about it');
assert.ok(/not<\/b> on the daily brief|not\b[^<]*on the daily brief/i.test(world.sent[0].html),
  'the email does NOT promise a brief they will never receive');

/* ── 3. notify:false — set up quietly, tell them yourself ─────────────────── */
reset();
({ out } = await addUser({ email: 'later@vodafone.com', name: 'Later', role: 'viewer', notify: false }));
assert.strictEqual(out.emailed, null, 'no email attempted');
assert.strictEqual(world.sent.length, 0, 'nothing sent');
assert.strictEqual(out.password, 'later123', 'the password still comes back so the admin can pass it on');

/* ── 4. someone who already has a password ────────────────────────────────── */
// The dangerous case: re-adding a person (reactivating, fixing a role) must not
// reset the password they chose, and must not mail them a stale one.
reset({ authExists: true });
({ out } = await addUser({ email: 'olduser@vodafone.com', name: 'Old User', role: 'admin' }));
assert.strictEqual(out.credentials, 'existing', 'reported as an existing account');
assert.strictEqual(out.password, null, 'no password is handed out');
assert.strictEqual(out.emailed, null, 'and none is emailed');
assert.strictEqual(world.sent.length, 0, 'nothing sent to someone whose password we did not set');
assert.strictEqual(world.users.length, 1, 'the allowlist row is still written (role/active are the point of re-adding)');
assert.strictEqual(world.users[0].role, 'admin', 'with the new role');

/* ── 5. someone already ON the subscriber list ────────────────────────────── */
// addSubscriber upserts every column, so a blind add would blank this person's
// category filter and their WhatsApp crisis number.
reset({ subscriber: { id: 9, email: 'sub@vodafone.com', name: 'Sub', categories: ['network'], whatsapp: '201001234567', active: true } });
({ out } = await addUser({ email: 'sub@vodafone.com', name: 'Sub', role: 'viewer' }));
assert.strictEqual(out.subscriber, 'already', 'recognised as already subscribed');
assert.strictEqual(world.subsPosted.length, 0, 'no upsert — their categories and WhatsApp number survive');
assert.strictEqual(world.subsPatched.length, 0, 'and an active row is not touched at all');

/* ── 6. a PAUSED subscriber is switched back on, not overwritten ──────────── */
reset({ subscriber: { id: 9, email: 'paused@vodafone.com', name: 'Paused', categories: ['network'], whatsapp: '201001234567', active: false } });
({ out } = await addUser({ email: 'paused@vodafone.com', name: 'Paused', role: 'viewer' }));
assert.strictEqual(out.subscriber, 'reactivated', 'a paused subscription is resumed');
assert.strictEqual(world.subsPosted.length, 0, 'without rewriting the row');
assert.strictEqual(world.subsPatched.length, 1, 'one targeted PATCH');
assert.deepStrictEqual(world.subsPatched[0].body, { active: true }, 'and it only flips `active`');

/* ── 7. a failed send is reported, never swallowed ────────────────────────── */
reset();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) return { ok: false, status: 422, text: async () => 'suppressed address' };
  return realFetch(url, opts);
};
({ out } = await addUser({ email: 'bounce@vodafone.com', name: 'Bounce', role: 'viewer' }));
globalThis.fetch = realFetch;
assert.strictEqual(out.credentials, 'created', 'the account is still provisioned');
assert.strictEqual(out.emailed, false, 'the send failure is reported');
assert.ok(/422|suppressed/.test(out.emailError || ''), `with the reason (got ${out.emailError})`);
assert.strictEqual(out.password, 'bounce123', 'and the password comes back, since the admin is now the only route');

/* ── 8. a two-letter first name still clears Supabase's 6-character floor ─── */
reset();
({ out } = await addUser({ email: 'ed@vodafone.com', name: 'Ed', role: 'viewer' }));
assert.ok(out.password.startsWith('ed123'), `keeps the convention (got ${out.password})`);
assert.ok(out.password.length >= 6, `but is long enough for Supabase to accept (got "${out.password}")`);
assert.strictEqual(world.created[0].password, out.password, 'and it is the password actually set');

/* ── 9. no name given — the email local part stands in ────────────────────── */
// And a four-letter first name must stay EXACTLY firstname123: the help text on
// the form promises that, and padding it would make the promise a lie for half
// the team.
reset();
({ out } = await addUser({ email: 'mona.said@vodafone.com', role: 'viewer' }));
assert.strictEqual(out.password, 'mona123', `derived from the address when no name is given (got ${out.password})`);

/* ── 10. the ADMIN'S OWN COPY of the welcome email ────────────────────────── */
// The response panel is gone the moment the page is closed, so the BCC is the
// admin's only lasting record of who was told what. It rides the signed-in
// session's address — which is exactly why the cron-token cases above could
// never have caught it breaking.
reset();
({ out } = await addUser({ email: 'newbie@vodafone.com', name: 'Newbie', role: 'viewer' }, SIGNED_IN));
assert.strictEqual(out.emailed, true, 'the welcome email sent');
assert.strictEqual(out.bccd, true, 'and the panel is told the admin was BCC-copied');
assert.deepStrictEqual(world.sent[0].to, ['newbie@vodafone.com'], 'the To is the new user alone');
assert.deepStrictEqual(world.sent[0].bcc, ['boss@vodafone.com'],
  `the signed-in admin is BCC'd (got ${JSON.stringify(world.sent[0].bcc)})`);
// BCC, never Cc or a second To: the new user must not be shown who provisioned
// them, and a group send would expose the password convention to a wider list.
assert.ok(!world.sent[0].cc, 'copied by BCC, not Cc');
assert.ok(/boss@vodafone\.com/.test(world.sent[0].html),
  'and the "anything not working" line names that admin, not an unset env var');

/* ── 11. an admin adding THEMSELVES gets no BCC, and is told so ───────────── */
// They are already the To. A BCC would be a second copy of the same mail, and
// the panel claiming "you are BCC'd" would be plainly wrong.
reset();
({ out } = await addUser({ email: 'boss@vodafone.com', name: 'Boss', role: 'admin' }, SIGNED_IN));
assert.strictEqual(out.emailed, true, 'the email still sends');
assert.strictEqual(out.bccd, false, 'but no BCC is claimed');
assert.deepStrictEqual(world.sent[0].to, ['boss@vodafone.com'], 'addressed to them once');
assert.ok(!world.sent[0].bcc, 'and not BCC-copied to themselves as well');

console.log('USER-PROVISION OK — adding a user sets a first-name starter password, optionally subscribes them to the daily brief, and emails their own sign-in; an existing password is never reset or re-mailed, an existing subscriber row is never overwritten, the password never reaches the audit log, and a failed send is reported with its reason');
