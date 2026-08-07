// One rule for every URL that came from outside and is about to become a link.
//
// PR Radar's article URLs are third-party data all the way down: a feed supplies
// them, `resolveUrl` rewrites them from whatever Google News hands back, and
// they are stored in pr_items.url / pr_items.resolved_url. From there they reach
// an `href` on the board, an `href` in five email templates, a webhook payload,
// a Word export — and, in /api/go, a `Location:` header on a PUBLIC endpoint
// that anyone can hit with any id.
//
// Nothing checked the SCHEME anywhere along that path. Escaping was in place
// (esc() on every rendered value), but escaping is the wrong tool: `javascript:`
// contains no character HTML-escaping touches, so `<a href="javascript:…">`
// survives it intact. And /api/go read a stored value straight into a 302,
// where escaping does not apply at all.
//
// So: one function, applied wherever a stored URL becomes a destination.
//
// WHY http: IS ALLOWED. Reluctantly and explicitly. Several Egyptian outlets
// still serve plain http, and a stored http article link is a real link to a
// real story — refusing it would blank working cards to buy nothing, because
// the browser is going to make the same request either way. What matters is
// that the set is a CLOSED allowlist of two rather than "anything with a colon".

/** The only two schemes a stored article link may use. */
export const SAFE_PROTOCOLS = Object.freeze(['https:', 'http:']);

// Longer than any real article URL (the longest Google News wrapper seen in
// production is ~2,000 chars, which is also what lib/db.js truncates to).
const MAX_URL_LENGTH = 2048;

// C0/C1 controls, including the ones used to smuggle a scheme past a naive
// filter: "java\tscript:", "java\nscript:", a leading NUL. `new URL` strips
// some of these itself, which is exactly why they are rejected BEFORE parsing
// rather than after — a value that needed cleaning to become safe is not a
// value this app stored on purpose.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Normalise an untrusted URL, or return null if it must never become a link.
 *
 *  → the canonical absolute URL string (what `new URL().href` produces), or
 *    null for: a non-string, an empty value, anything over the length cap,
 *    control characters, an unparseable value, a relative/protocol-relative
 *    reference, a scheme outside SAFE_PROTOCOLS (javascript:, data:, blob:,
 *    file:, ftp:, chrome:, vbscript:, mailto:, …), a hostless URL, or one
 *    carrying embedded credentials.
 *
 *  Credentials are refused because `https://vodafone.com.eg@evil.example/x` is
 *  a real link to evil.example that reads as a link to Vodafone — no article
 *  URL has ever carried a userinfo section, and a reader checking the domain
 *  before tapping would be checking the wrong half of the string. */
export function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  if (CONTROL_CHARS.test(raw)) return null;
  // A protocol-relative reference ("//evil.example/x") inherits the page's
  // scheme and would resolve against the board's own origin. Absolute only.
  if (raw.startsWith('//')) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!SAFE_PROTOCOLS.includes(u.protocol)) return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** Boolean face of the same rule, for filters and assertions. */
export function isSafeExternalUrl(value) {
  return safeExternalUrl(value) !== null;
}

/** The first safe URL among its arguments, or `fallback` (default null).
 *
 *  The shape every caller in this repo actually needs: a card carries a decoded
 *  `resolved_url` AND the original wrapper `url`, and wants the best usable one.
 *  Written as a helper so "prefer resolved, fall back to url, give up honestly"
 *  is one decision rather than a `||` chain repeated in seven renderers — each
 *  of which would otherwise have to remember to check. */
export function firstSafeUrl(...values) {
  for (const v of values) {
    const safe = safeExternalUrl(v);
    if (safe) return safe;
  }
  return null;
}
