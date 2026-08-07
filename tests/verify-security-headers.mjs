// The browser-side security posture lives entirely in vercel.json — there is no
// framework and no middleware to put it in — so it is invisible in code review
// and silently deletable. This asserts it, directive by directive, and each
// assertion says what the directive is for and what would break without it.
//
// It also checks the app AGAINST the policy: a CSP is only true if the pages
// can actually live inside it, and the two easiest ways to be wrong are
// declaring a directive the app violates, and quietly widening one until it
// stops complaining.
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const vercel = JSON.parse(readFileSync(root + 'vercel.json', 'utf8'));
const PUBLIC = root + 'public';

const rule = (vercel.headers || []).find((h) => h.source === '/(.*)');
assert.ok(rule, 'a header rule covers every path');
const H = Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));

// ── 1. the headers that already existed must not be lost ──────────────────
assert.strictEqual(H['x-content-type-options'], 'nosniff', 'nosniff');
assert.strictEqual(H['x-frame-options'], 'DENY', 'X-Frame-Options (the pre-CSP clickjacking guard)');
assert.strictEqual(H['referrer-policy'], 'no-referrer',
  'no-referrer — a board URL carries an item id, and article links leave to third-party outlets');
assert.match(H['permissions-policy'], /geolocation=\(\)/, 'Permissions-Policy still denies the sensors');

// ── 2. HSTS ───────────────────────────────────────────────────────────────
{
  const hsts = H['strict-transport-security'];
  assert.ok(hsts, 'Strict-Transport-Security is set — this is a password-authenticated app on HTTPS');
  const maxAge = Number(hsts.match(/max-age=(\d+)/)?.[1] || 0);
  assert.ok(maxAge >= 31536000, `max-age is at least a year (got ${maxAge})`);
  assert.match(hsts, /includeSubDomains/, 'includeSubDomains');
  // `preload` is deliberately ABSENT. Submitting to the browser preload list is
  // effectively irreversible and binds the whole registrable domain, which is
  // the owner's decision to make, not a side effect of a hardening commit.
  assert.ok(!/preload/.test(hsts), 'preload is NOT claimed — it is irreversible and needs an owner decision');
}

// ── 3. the CSP, directive by directive ────────────────────────────────────
const csp = H['content-security-policy'];
assert.ok(csp, 'a Content-Security-Policy is set');
const D = Object.fromEntries(csp.split(';').map((p) => p.trim()).filter(Boolean)
  .map((p) => { const [k, ...v] = p.split(/\s+/); return [k, v]; }));

assert.deepStrictEqual(D['default-src'], ["'self'"], 'everything not named falls back to same-origin');
assert.deepStrictEqual(D['base-uri'], ["'none'"],
  '<base> injection would silently repoint every relative URL on the page, including /api/*');
assert.deepStrictEqual(D['object-src'], ["'none'"], 'no plugins, ever');
assert.deepStrictEqual(D['frame-ancestors'], ["'none'"], 'clickjacking — the CSP half of X-Frame-Options');
assert.deepStrictEqual(D['form-action'], ["'self'"],
  'the sign-in form posts passwords; an injected form must not be able to post them elsewhere');
assert.deepStrictEqual(D['frame-src'], ["'none'"], 'the app embeds nothing');

// img-src needs blob: — the card snapshot renders to a canvas, and the preview
// in the share sheet is an <img src="blob:…">. Without it 📸 shows a broken
// image and nothing in the console explains why.
assert.deepStrictEqual(D['img-src'], ["'self'", 'data:', 'blob:'],
  'img-src allows blob: for the card snapshot and data: for inline marks — and nothing remote');
// worker-src blob: is the same family of reason; it costs nothing and prevents
// a future Web Worker being blocked with no obvious cause.
assert.ok(D['worker-src'].includes("'self'"), 'worker-src is same-origin at most');

// connect-src is the one directive with a remote origin, and it has to be:
// every page refreshes its Supabase session directly against GoTrue.
assert.ok(D['connect-src'].includes("'self'"), 'connect-src allows our own API');
assert.ok(D['connect-src'].includes('https://*.supabase.co'),
  'and Supabase, because refreshSession() posts to ${supabaseUrl}/auth/v1/token — without this every page signs the user out on token expiry');
assert.strictEqual(D['connect-src'].length, 2, 'connect-src names exactly those two and nothing else');
// Wildcarded to the provider, never the project ref — a ref does not belong in
// a tracked file (see the CLAUDE.md rule).
assert.ok(!/[a-z0-9]{20}\.supabase\.co/.test(csp), 'the Supabase project ref is not embedded in the policy');

// script-src / style-src: 'unsafe-inline' is present ON PURPOSE and is the one
// remaining weakness. Every page is self-contained by design (inline <script>
// and <style>, no build step), the board and admin carry ~55 inline onclick
// handlers, and the PDF export opens a blob: document that INHERITS this policy
// and calls window.print() from an inline handler. Removing 'unsafe-inline'
// means de-inlining all of that first; declaring it before then would ship a
// blank board. Asserted, so it is a recorded decision rather than an oversight.
assert.ok(D['script-src'].includes("'self'"), "script-src is 'self' plus the inline allowance");
assert.ok(D['script-src'].includes("'unsafe-inline'"),
  "script-src still needs 'unsafe-inline' — see the de-inlining note in CLAUDE.md");
assert.ok(!D['script-src'].includes("'unsafe-eval'"), "but NEVER 'unsafe-eval'");
assert.ok(!D['script-src'].some((s) => s.startsWith('http')), 'and no remote script origin');
assert.ok(!D['style-src'].some((s) => s.startsWith('http')), 'and no remote style origin');

// upgrade-insecure-requests is deliberately ABSENT: it rewrites outgoing
// navigations, and several Egyptian outlets still serve plain http — the exact
// links lib/safe-url.js keeps on purpose. Upgrading them would break real
// article links to buy nothing.
assert.ok(!/upgrade-insecure-requests/.test(csp),
  'upgrade-insecure-requests is not set — it would break the http-only outlet links safe-url deliberately allows');

assert.strictEqual(H['cross-origin-opener-policy'], 'same-origin',
  'COOP severs any cross-origin opener relationship');

// ── 4. the app must actually FIT the policy ───────────────────────────────
// A CSP is a claim about the app. These are the ways this app could break it.
{
  for (const f of readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(`${PUBLIC}/${f}`, 'utf8');
    // No remote subresource: default-src 'self' blocks them, so one would be a
    // page that silently stops working rather than an obvious mistake.
    for (const m of html.match(/<(script|link|img|iframe)\b[^>]*(src|href)="https?:\/\/[^"]*"/gi) || []) {
      assert.fail(`${f}: remote subresource would be blocked by the CSP — ${m.slice(0, 120)}`);
    }
    assert.ok(!/<base\b/i.test(html), `${f}: a <base> tag would be blocked by base-uri 'none'`);
    // eval / new Function would need 'unsafe-eval', which is refused above.
    assert.ok(!/\beval\s*\(/.test(html), `${f}: eval() would need 'unsafe-eval'`);
    assert.ok(!/new\s+Function\s*\(/.test(html), `${f}: new Function() would need 'unsafe-eval'`);
    // The only cross-origin request the pages make is the Supabase token
    // refresh, which is built from the config endpoint's value at runtime.
    // Anything hard-coded would be blocked by connect-src, so it must not exist.
    for (const m of html.match(/fetch\(\s*['"`]https?:\/\/[^'"`]*/gi) || []) {
      assert.fail(`${f}: a hard-coded cross-origin fetch would be blocked by connect-src — ${m.slice(0, 100)}`);
    }
  }
}

console.log('SECURITY-HEADERS OK — CSP (default/base-uri/object/frame-ancestors/form-action locked; blob: only where the snapshot and exports need it; Supabase the only remote connect origin), HSTS without preload, COOP, and the pre-existing four; the pages are verified to fit the policy');
