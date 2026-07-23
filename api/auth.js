// Task 16 — auth endpoint (email + password sign-in + identity).
//
//   GET  /api/auth?view=config             → { supabaseUrl, anonKey } (public; session refresh)
//   GET  /api/auth?view=me                 → { email, role, kind }    (401 if not signed in)
//   POST /api/auth { mode:'signup', email, password } → create the account (allowlisted only)
//   POST /api/auth { mode:'signin', email, password } → return a session { access_token, ... }
//   POST /api/auth { mode:'magiclink', email }        → (optional) email a sign-in link
//
// Access is the closed allowlist (ADMIN_EMAILS + pr_users): only those emails can
// create an account or sign in. Accounts are created pre-confirmed via the admin
// API, so NO confirmation email is sent — password login needs no email at all.

import { roleFor, requireRole, auditReq } from '../lib/auth.js';
import { sendBulletin } from '../lib/email.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PW = 8;

export default async function handler(req, res) {
  const view = req.query.view;

  if (req.method === 'GET' && view === 'config') {
    return res.status(200).json({
      supabaseUrl: process.env.SUPABASE_URL || null,
      anonKey: process.env.SUPABASE_ANON_KEY || null,
      configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    });
  }

  if (req.method === 'GET' && (view === 'me' || !view)) {
    const who = await requireRole(req, res, 'viewer');
    if (!who) return; // 401 already sent
    return res.status(200).json({ email: who.email || null, role: who.role, kind: who.kind });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const mode = body.mode || req.query.mode || 'signin';
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'a valid email is required' });

    // ── create account ──
    if (mode === 'signup') {
      if (password.length < MIN_PW) return res.status(400).json({ error: `password must be at least ${MIN_PW} characters` });
      let role = null;
      try { role = await roleFor(email); } catch { role = null; }
      if (!role) return res.status(403).json({ error: "this email isn't authorised — ask an admin to add you first" });
      try {
        const outcome = await adminCreateUser(email, password);
        if (outcome === 'exists') return res.status(409).json({ error: 'an account already exists for this email — sign in instead', exists: true });
        await auditReq(req, { actor: email, role }, 'auth.signup', email, null);
        const tok = await passwordGrant(email, password);           // auto sign-in
        if (tok) return res.status(200).json({ ok: true, ...tok, role });
        return res.status(200).json({ ok: true });
      } catch (e) {
        console.error('signup failed', e.message);
        return res.status(500).json({ error: 'sign-up failed, please try again' });
      }
    }

    // ── sign in ──
    if (mode === 'signin') {
      const tok = await passwordGrant(email, password);
      if (!tok) return res.status(401).json({ error: 'wrong email or password' });
      let role = null;
      try { role = await roleFor(email); } catch { role = null; }
      if (!role) return res.status(403).json({ error: "this account isn't authorised for the board" });
      await auditReq(req, { actor: email, role }, 'auth.signin', email, null);
      return res.status(200).json({ ok: true, ...tok, role });
    }

    // ── optional: magic-link (kept as a fallback, not exposed in the UI) ──
    if (mode === 'magiclink') {
      const generic = () => res.status(200).json({ ok: true });
      let role = null;
      try { role = await roleFor(email); } catch { role = null; }
      if (!role) return generic();
      try {
        await sendMagicLink(email, req);
        await auditReq(req, { actor: email, role }, 'auth.link_sent', email, null);
      } catch (e) { console.error('magic-link send failed', e.message); }
      return generic();
    }

    return res.status(400).json({ error: 'unknown mode' });
  }

  return res.status(405).json({ error: 'method not allowed' });
}

// Create a pre-confirmed Supabase user (no confirmation email). Returns 'created'
// or 'exists'; throws on any other failure.
async function adminCreateUser(email, password) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('supabase not configured');
  const r = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (r.ok) return 'created';
  const txt = await r.text();
  if (r.status === 422 || /already|registered|exists|duplicate/i.test(txt)) return 'exists';
  throw new Error(`admin create ${r.status}: ${txt}`);
}

// Exchange email + password for a Supabase session. Returns tokens or null.
async function passwordGrant(email, password) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.access_token) return null;
    return { access_token: d.access_token, refresh_token: d.refresh_token || '' };
  } catch { return null; }
}

async function sendMagicLink(email, req) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('supabase not configured');
  const redirect = process.env.BOARD_URL || `https://${req.headers.host || ''}/`;
  const r = await fetch(`${base}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirect }),
  });
  if (!r.ok) throw new Error(`generate_link ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const link = data.action_link || (data.properties && data.properties.action_link);
  if (!link) throw new Error('no action_link in generate_link response');
  // Send the branded, same-domain link (see api/verify.js) — falls back to the
  // raw Supabase link if the board origin can't be resolved, so login never breaks.
  await sendBulletin(magicEmailHtml(brandedLink(link, redirect)), 'Sign in to PR Radar', email);
}

// Wrap the raw Supabase verify URL in a redirect on the board's own domain, so
// the visible sign-in link matches the sender domain (deliverability).
function brandedLink(actionLink, redirect) {
  let origin;
  try { origin = new URL(redirect).origin; } catch { return actionLink; }
  const u = Buffer.from(actionLink, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${origin}/auth/verify?u=${u}`;
}

function magicEmailHtml(link) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html><body style="margin:0;background:#f1f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e7e9ee;">
      <tr><td style="background:#e60000;padding:20px 28px;">
        <span style="display:inline-block;width:34px;height:34px;border-radius:9px;background:#ffffff;color:#e60000;font-weight:800;font-size:13px;text-align:center;line-height:34px;">PR</span>
        <span style="color:#ffffff;font-weight:800;font-size:16px;vertical-align:middle;margin-left:10px;">PR Radar</span>
      </td></tr>
      <tr><td style="padding:28px;">
        <div style="font-size:17px;font-weight:700;color:#16191f;">Sign in to PR Radar</div>
        <div style="font-size:14px;color:#5b6675;line-height:1.5;margin:10px 0 20px;">Click the button below to sign in. This link is single-use and expires shortly. If you didn't request it, you can ignore this email.</div>
        <a href="${esc(link)}" style="display:inline-block;background:#e60000;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">Sign in →</a>
        <div style="font-size:12px;color:#9aa2ad;margin-top:22px;">Brand &amp; Reputation monitor · Vodafone Egypt</div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
