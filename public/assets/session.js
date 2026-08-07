/* The session, in one place.
 *
 * This block existed SIX TIMES — index, stats, admin, account, context and
 * reports each carried its own copy of "read pr_session, refresh it against
 * GoTrue, attach a Bearer header, retry once on 401". Not similar copies:
 * character-for-character identical ones, because each page was written by
 * pasting the last. That is six places for a security-relevant fix to be
 * applied, and the failure mode is silent — five pages get the fix and the
 * sixth keeps the bug until someone happens to open it.
 *
 * PR Radar pages are self-contained on purpose (no build step, no framework),
 * and that stays true for everything a page actually owns: its own markup,
 * styles and behaviour. Authentication is not that. It is one mechanism the
 * whole app shares, and a copy of it per page was never a design decision.
 *
 * It is also the groundwork for tightening the CSP: script-src still needs
 * 'unsafe-inline' because the pages carry inline handlers, and every block that
 * moves into /assets is one less thing standing between here and dropping it.
 *
 * Loaded as a CLASSIC script, before each page's inline block, so its
 * declarations are already in scope. Not `defer`: the inline scripts run at
 * parse time and call into this immediately.
 *
 * TOKEN HANDLING — the rules this file exists to keep in one place:
 *   - the token travels in the Authorization header and NOWHERE else. Never a
 *     query string, never a URL, never a form field, never a log line.
 *   - the only place it is persisted is localStorage under `pr_session`.
 *   - a 401 buys exactly ONE silent refresh attempt; a second 401 is a real
 *     one and reaches the caller, which is what stops a refresh loop.
 *
 * RESIDUAL RISK, recorded rather than hidden: access and refresh tokens live in
 * localStorage, so any successful XSS reads them. Moving to Secure HttpOnly
 * SameSite cookies is the real fix and is NOT a small change — Supabase's
 * GoTrue hands tokens to the browser, so it needs a server-side session
 * exchange, a CSRF defence on every mutating endpoint, and a rewrite of the
 * refresh path. A half-migration would be worse than either end state. This
 * file is the preparation for it: one implementation to change instead of six.
 */

/* eslint-disable no-var */

// The current session, or null. Written only by saveSession().
var session = (() => {
  try { return JSON.parse(localStorage.getItem('pr_session') || 'null'); } catch (e) { return null; }
})();

/** Persist (or clear) the session. The single writer, so there is one place
    that decides what a stored session looks like. */
function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem('pr_session', JSON.stringify(s));
    else localStorage.removeItem('pr_session');
  } catch (e) { /* private mode, quota — the in-memory session still works */ }
}

/** Sign out and go to the sign-in screen.
    `pr_token` is a pre-Bearer-auth leftover that nothing writes any more;
    clearing it evicts it from browsers that still carry one. */
function signOut() {
  saveSession(null);
  try { localStorage.removeItem('pr_token'); } catch (e) {}
  location.href = '/login';
}

/** Capture a session handed over in the URL fragment (the magic-link return),
    store it, and strip it from the address bar so the tokens do not linger in
    history or get shared with a copied URL. Called by pages that can be a
    magic-link landing target. */
function captureSessionFromHash() {
  if (!location.hash) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  const at = h.get('access_token');
  if (!at) return false;
  saveSession({ access_token: at, refresh_token: h.get('refresh_token') || '' });
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// Supabase URL + anon key, fetched once per page from our own API rather than
// baked into the HTML.
var _cfg = null;
async function authConfig() {
  if (_cfg) return _cfg;
  try { _cfg = await (await fetch('/api/auth?view=config')).json(); } catch (e) { _cfg = {}; }
  return _cfg;
}

/** Exchange the refresh token for a new access token. → true on success.
    Fail-soft: any failure returns false and the caller surfaces the original
    401, which sends the user to sign in. */
async function refreshSession() {
  if (!session || !session.refresh_token) return false;
  const c = await authConfig();
  if (!c.supabaseUrl || !c.anonKey) return false;
  try {
    const r = await fetch(`${c.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    if (!d.access_token) return false;
    // GoTrue may or may not rotate the refresh token; keep the old one if not.
    saveSession({ access_token: d.access_token, refresh_token: d.refresh_token || session.refresh_token });
    return true;
  } catch (e) { return false; }
}

/** fetch() with the session attached, and one silent refresh on a 401.
    `_retried` bounds it to a single retry — without that a genuinely expired
    session loops. */
async function afetch(path, opts = {}, _retried) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (session) o.headers.Authorization = `Bearer ${session.access_token}`;
  const r = await fetch(path, o);
  if (r.status === 401 && session && !_retried && await refreshSession()) return afetch(path, opts, true);
  return r;
}
