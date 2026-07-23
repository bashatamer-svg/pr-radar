// Task 16 — identity, RBAC and audit.
//
// Auth model: passwordless magic-link via Supabase Auth. A request carries a
// Supabase session JWT (Authorization: Bearer <jwt>). We verify it, resolve the
// email against the CLOSED allowlist (ADMIN_EMAILS env + pr_users table), and
// attach a role (admin | viewer). No allowlist match → no access.
//
// Machine/legacy callers still work: RADAR_TOKEN and CRON_SECRET resolve to a
// service principal (admin) so the cron jobs and existing ?t=<token> board
// links keep functioning while human sign-in is layered on top.
//
// SHARED-PROJECT SAFETY: role/audit data lives in pr_users / pr_audit (pr_*).

import crypto from 'node:crypto';
import { getUserByEmail, touchUserSeen, addAudit } from './db.js';

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
    if (p) { email = p.email || (p.user_metadata && p.user_metadata.email) || null; exp = p.exp || 0; }
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

// Find a Supabase auth user's id by email (paginated admin list). Null if none.
async function adminFindUserId(email) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const e = String(email || '').toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    const d = await r.json();
    const users = Array.isArray(d) ? d : (d.users || []);
    const hit = users.find((u) => String(u.email || '').toLowerCase() === e);
    if (hit) return hit.id;
    if (users.length < 1000) break;
  }
  return null;
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
