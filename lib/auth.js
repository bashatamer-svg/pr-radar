// Task 16 — identity, RBAC and audit.
//
// Auth model: passwordless magic-link via Supabase Auth. A request carries a
// Supabase session JWT (Authorization: Bearer <jwt>). We verify it, resolve the
// email against the CLOSED allowlist (ADMIN_EMAILS env + pr_users table), and
// attach a role (admin | viewer). No allowlist match → no access.
//
// Machine callers resolve to a SERVICE principal, and the two are not equal:
// CRON_SECRET is an operator (admin), RADAR_TOKEN is read-only (viewer). See
// the authorization-model table above requireOperator().
//
// SHARED-PROJECT SAFETY: role/audit data lives in pr_users / pr_audit (pr_*).

import crypto from 'node:crypto';
import { getUserByEmail, touchUserSeen, addAudit, upsertUser } from './db.js';

export const ROLES = { viewer: 1, admin: 2 };

// ── JWT verification ────────────────────────────────────────────────────────
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return Buffer.from(s, 'base64');
}

// Verify an HS256 Supabase JWT locally with the project's JWT secret. Returns the
// decoded payload or null. Constant-time signature check; expiry enforced.
export function verifyHs256(token, secret = process.env.SUPABASE_JWT_SECRET) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  } catch { return null; }
  if ((header.alg || '').toUpperCase() !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let got;
  try { got = b64urlToBuf(sig); } catch { return null; }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  // Supabase signs the anon/service_role API keys with this SAME secret, so a
  // valid signature alone isn't proof of a signed-in USER. Require an end-user
  // access token: role 'authenticated' and aud includes 'authenticated'.
  if (payload.role && payload.role !== 'authenticated') return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.aud && !aud.includes('authenticated')) return null;
  return payload;
}

// Fallback: validate the token against GoTrue directly (works for any signing
// algorithm, no JWT secret needed). One network hop; used only when
// SUPABASE_JWT_SECRET is not configured.
async function verifyViaGoTrue(token) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const _cache = new Map(); // token → { email, exp(sec) } — dedupes verification within a warm lambda

/** Verify a session token and return its email, or null. */
export async function verifyToken(token) {
  if (!token) return null;
  const c = _cache.get(token);
  if (c && c.exp * 1000 > Date.now()) return c.email;
  let email = null, exp = 0;
  if (process.env.SUPABASE_JWT_SECRET) {
    const p = verifyHs256(token);
    if (p) { email = p.email || null; exp = p.exp || 0; }
  } else {
    const u = await verifyViaGoTrue(token);
    if (u) { email = u.email || null; exp = Math.floor(Date.now() / 1000) + 60; }
  }
  if (!email) return null;
  if (_cache.size > 500) _cache.clear();
  _cache.set(token, { email: email.toLowerCase(), exp: exp || Math.floor(Date.now() / 1000) + 60 });
  return email.toLowerCase();
}

// ── Allowlist / roles ───────────────────────────────────────────────────────
function adminEnvList() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Resolve an email to a role, or null if it is not on the closed allowlist.
    ADMIN_EMAILS always wins (bootstrap / lock-out insurance); otherwise the
    email must be an ACTIVE row in pr_users. */
export async function roleFor(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (adminEnvList().includes(e)) return 'admin';
  let u = null;
  try { u = await getUserByEmail(e); } catch { u = null; }
  if (u && u.active) return u.role === 'admin' ? 'admin' : 'viewer';
  return null;
}

export function ipOf(req) {
  const xf = req.headers?.['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || null;
}

/** Constant-time string comparison (avoids leaking secrets via timing). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Resolve the request's principal, or null if unauthenticated / not allowed.
    → { kind:'service'|'user', actor, role, email? }

    Tokens are accepted ONLY in the Authorization header — never in a ?t= query
    string (which would leak into logs, history and Referer). CRON_SECRET is a
    full service principal; the shared RADAR_TOKEN is read-only (viewer). */
export async function principal(req) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const RADAR = process.env.RADAR_TOKEN, CRON = process.env.CRON_SECRET;
  if (CRON && safeEqual(bearer, CRON)) return { kind: 'service', actor: 'service:cron', role: 'admin' };
  if (RADAR && safeEqual(bearer, RADAR)) return { kind: 'service', actor: 'service:token', role: 'viewer' };
  if (bearer) {
    const email = await verifyToken(bearer);
    if (email) {
      const role = await roleFor(email);
      if (role) return { kind: 'user', actor: email, email, role };
    }
  }
  return null;
}

/** Gate a handler. Returns the principal, or null after having sent 401/403.
    Callers: `const who = await requireRole(req, res, 'admin'); if (!who) return;` */
export async function requireRole(req, res, min = 'viewer') {
  const p = await principal(req);
  if (!p) { res.status(401).json({ error: 'unauthorized', login: true }); return null; }
  if ((ROLES[p.role] || 0) < (ROLES[min] || 1)) { res.status(403).json({ error: 'forbidden', role: p.role }); return null; }
  if (p.kind === 'user') touchUserSeen(p.email); // best-effort, fire-and-forget
  return p;
}

/* ── The authorization model, in one place ──────────────────────────────────

   Principal            Role     Can read      Can OPERATE
   ───────────────────  ───────  ────────────  ──────────────────────────────
   CRON_SECRET          admin    yes           yes  (this is what Vercel Cron
                                                    sends, so it must)
   RADAR_TOKEN          viewer   yes           NO
   signed-in admin      admin    yes           yes
   signed-in viewer     viewer   yes           NO
   anything else        —        no            no

   "OPERATE" means: ingest, classify, write stories, send a brief, fire an
   alert, page a phone, run a backfill that writes — anything with an effect
   outside the response body.

   `/api/radar` and `/api/geo` used to accept RADAR_TOKEN alongside CRON_SECRET
   with their own inline `safeEqual` pair, which contradicted the table above:
   RADAR_TOKEN is the SHARED read token, so anyone holding it could trigger a
   full ingest, mail the subscriber list, and page the WhatsApp crisis numbers.
   Two separate authorization implementations is also how a policy drifts —
   `principal()` was tightened for the rest of the app and those two endpoints
   simply did not hear about it.

   Read-only is judged by EFFECT, not by whether a row is written. `?dry=1`
   stores nothing, but it still fetches thirty feeds and pays for a round of
   classifier calls, so it is an operation and needs the operator gate. A gate
   that lets a read token spend money is not a read gate.
   ───────────────────────────────────────────────────────────────────────── */

/** Gate an endpoint that DOES something (ingest, send, page, backfill).
    Returns the principal, or null after having sent 401/403.

    Use this instead of `requireRole(req, res, 'admin')` at operational
    entry points: same rule, but the name states the policy at the call site,
    and there is one place to change it if the policy ever moves. */
export async function requireOperator(req, res) {
  return requireRole(req, res, 'admin');
}

// Find a Supabase auth user's id by email (paginated admin list). Null if none.
/** Find a Supabase auth user by email via the admin list. Returns the raw user
    object (id, created_at, …) or null. Exported so signup's "already exists"
    response can say WHEN the account was created. */
export async function adminFindUser(email) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const e = String(email || '').toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    const d = await r.json();
    const users = Array.isArray(d) ? d : (d.users || []);
    const hit = users.find((u) => String(u.email || '').toLowerCase() === e);
    if (hit) return hit;
    if (users.length < 1000) break;
  }
  return null;
}
async function adminFindUserId(email) {
  return (await adminFindUser(email))?.id ?? null;
}

/** CREATE a pre-confirmed account with a password, and only that.
    → 'created' | 'exists'; throws if Supabase is unconfigured or answers oddly.

    Create-only ON PURPOSE, and the difference from `adminSetPassword` matters:
    that one falls back to a PUT when the account exists, so using it to
    provision would silently RESET the password of anyone who already has one.
    Here the server decides — an existing account comes back 422 and is reported
    as 'exists' — so there is no read-then-write window in which a failed lookup
    can be mistaken for "no account yet". */
export async function adminCreateUser(email, password) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('supabase not configured');
  const r = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').toLowerCase(), password, email_confirm: true }),
  });
  if (r.ok) return 'created';
  const txt = await r.text();
  if (r.status === 422 || /already|registered|exists|duplicate/i.test(txt)) return 'exists';
  throw new Error(`admin create ${r.status}: ${txt}`);
}

/** Set (or, if the account doesn't exist yet, create pre-confirmed) a user's
    password. Used by self-service change and admin reset. Returns true on success. */
export async function adminSetPassword(email, password) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return false;
  const e = String(email || '').toLowerCase();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const id = await adminFindUserId(e);
  if (id) {
    const r = await fetch(`${base}/auth/v1/admin/users/${id}`, { method: 'PUT', headers, body: JSON.stringify({ password, email_confirm: true }) });
    return r.ok;
  }
  const r = await fetch(`${base}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email: e, password, email_confirm: true }) });
  return r.ok;
}

/* ── Provisioning a person (Admin → Users) ──────────────────────────────────
   An allowlist row alone is only half an account: the person still has to guess
   that they may now "Create account" on the login screen, and an ADMIN cannot
   even do that (self-signup refuses role=admin, deliberately). So adding a user
   sets a temporary password too, and the welcome email carries it.
   ─────────────────────────────────────────────────────────────────────────── */

/* The starter password used to be a CONVENTION: first name + "123", so
   "Tamer Basha" got `tamer123`. It was chosen so an admin could say it over the
   phone without looking it up — a real convenience, bought at a price nobody
   priced. The allowlist is a corporate mailing list, first names are on it, and
   the sign-in page is public: anyone who could guess a colleague's first name
   could guess their password, and the window is not "until they change it" but
   "until they get round to it". A working production account behind a guessable
   credential is not a starter password, it is an unlocked door.

   So the credential is now RANDOM and nothing about it is derived from the
   person — not their name, their email, their role, their id, nor the time it
   was issued (a timestamped seed is guessable by anyone who knows roughly when
   the account was made).

   The readability the old convention bought is kept in the FORMAT rather than
   the content: an unambiguous alphabet in hyphenated groups, the same shape as
   a recovery code, so it is still sayable and typeable. It is never logged,
   never written to pr_audit, and reaches exactly two places — the response to
   the admin who asked for it, and the welcome email to its own owner. */

// 32 characters, so each 5-bit group of randomness maps to one character with
// NO modulo bias. `i` and `l` are omitted (they read as `1`), and `0`/`1` are
// not in the set at all, so nothing here is ambiguous when read aloud.
const PW_ALPHABET = '23456789abcdefghjkmnopqrstuvwxyz';
const PW_GROUPS = 6;          // 6 groups × 5 chars × 5 bits = 150 bits
const PW_GROUP_LEN = 5;

/** A cryptographically random temporary password: 150 bits, in six
    hyphen-separated groups of five (`k7mpq-9xnrt-3tbwj-5hzvd-8fcgs-4ynkm`).
    Derived from nothing — call it twice for the same person and the two
    answers are unrelated. */
export function generateTempPassword() {
  const n = PW_GROUPS * PW_GROUP_LEN;
  const bytes = crypto.randomBytes(n);          // one byte per character…
  let out = '';
  for (let i = 0; i < n; i++) {
    // …of which the low 5 bits are used. 32 divides 256 exactly, so masking is
    // uniform — no rejection sampling needed and no modulo bias introduced.
    out += PW_ALPHABET[bytes[i] & 31];
    if ((i + 1) % PW_GROUP_LEN === 0 && i + 1 < n) out += '-';
  }
  return out;
}

/** Bits of entropy in a generated temporary password. Exported so a test can
    assert the strength rather than re-deriving it from the constants. */
export const TEMP_PASSWORD_BITS = PW_GROUPS * PW_GROUP_LEN * 5;

/** Provision a person in one step: the allowlist row PLUS a temporary password,
    so someone added in Admin → Users can sign in immediately.
    → { user, credentials, error }

    `credentials` is:
      'created'  — the temporary password was set; it is safe to email it
      'existing' — an account already exists, so the password is THEIRS and is
                   left untouched. Re-adding someone (reactivating a blocked
                   user, fixing their role) must never reset a password they
                   chose, and must never mail them one that no longer works.
      'failed'   — the allowlist row is written but no password could be set.
                   Reported, never glossed over: the person is allowlisted but
                   cannot sign in until someone sets one.

    The allowlist row is written FIRST and independently. It is what gates
    access, and it is also what lets a viewer self-signup as a fallback, so it
    must survive a credential failure. */
export async function provisionUser({ email, name, role = 'viewer', invited_by, password }) {
  const e = String(email || '').trim().toLowerCase();
  const rows = await upsertUser({ email: e, role, name, invited_by });
  const user = Array.isArray(rows) ? rows[0] : rows;
  try {
    const outcome = await adminCreateUser(e, password);
    return { user, credentials: outcome === 'created' ? 'created' : 'existing', error: null };
  } catch (err) {
    return { user, credentials: 'failed', error: err.message };
  }
}

/** Write an audit row stamped with the principal + request IP. Fail-soft. */
export async function auditReq(req, who, action, target, detail) {
  return addAudit({
    actor: who?.actor || null,
    actor_role: who?.role || null,
    action,
    target,
    detail: detail == null ? null : detail,
    ip: ipOf(req),
  });
}
