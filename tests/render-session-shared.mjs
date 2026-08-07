// One session implementation, not seven.
//
// "Read pr_session, refresh it against GoTrue, attach a Bearer header, retry
// once on 401" existed SIX TIMES — index, stats, admin, account, context and
// reports — plus a seventh partial copy in login, which writes the session the
// other six read. Not similar copies: character-for-character identical ones,
// because each page was written by pasting the last.
//
// That is six places for a security-relevant fix to land, and the failure mode
// is silent: five pages get it, the sixth keeps the bug until someone opens it.
//
// PR Radar pages are self-contained on purpose, and that stays true for what a
// page owns — its markup, styles and behaviour. Authentication is not that.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url).pathname;
const DIR = root + 'public';
const PAGES = ['index', 'stats', 'admin', 'account', 'context', 'reports', 'login'];

/* ── 1. no page carries its own copy any more ───────────────────────────── */
{
  for (const name of PAGES) {
    const html = readFileSync(`${DIR}/${name}.html`, 'utf8');
    assert.match(html, /<script src="\/assets\/session\.js"><\/script>/,
      `${name}.html loads the shared session module`);
    // A redeclaration would also be a hard SyntaxError (var in one script, let
    // in another at the same top level), so this catches a silent regression
    // AND names it.
    for (const fn of ['refreshSession', 'authConfig', 'afetch', 'saveSession']) {
      assert.ok(!new RegExp(`function ${fn}\\s*\\(`).test(html),
        `${name}.html must not redefine ${fn} — it comes from /assets/session.js`);
    }
    assert.ok(!/localStorage\.setItem\(\s*['"]pr_session['"]/.test(html),
      `${name}.html must not write pr_session directly — saveSession() is the single writer`);
  }
  // The module is loaded BEFORE the page's own block, not deferred: the inline
  // scripts run at parse time and call into it immediately.
  for (const name of PAGES) {
    const html = readFileSync(`${DIR}/${name}.html`, 'utf8');
    const shared = html.indexOf('/assets/session.js');
    const own = html.indexOf('<script>', shared);
    assert.ok(shared !== -1 && own > shared, `${name}.html loads the shared module before its own script`);
    assert.ok(!/session\.js"\s+defer/.test(html), `${name}.html does not defer it`);
  }
}

/* ── 2. the module keeps the token rules ────────────────────────────────── */
{
  const js = readFileSync(`${DIR}/assets/session.js`, 'utf8');
  // Bearer header only. The ?t= query token was deliberately purged from this
  // app; a shared module is exactly where it could quietly come back.
  assert.match(js, /headers\.Authorization = `Bearer \$\{session\.access_token\}`/,
    'the token travels in the Authorization header');
  assert.ok(!/[?&]t=/.test(js), 'and never as a ?t= query parameter');
  assert.ok(!/console\.(log|error|warn)/.test(js), 'nothing here logs — a log line is a place for a token to land');
  // One silent retry, bounded. Without the bound an expired session loops.
  assert.match(js, /!_retried && await refreshSession\(\)/, 'a 401 buys exactly one refresh attempt');
  // The residual risk is written down rather than left to be discovered.
  assert.match(js, /localStorage, so any successful XSS reads them/i,
    'the localStorage exposure is documented as known debt, not glossed over');
}

/* ── 3. it actually WORKS, on every page, in a browser ──────────────────── */
{
  let refreshes = 0, expired = true;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (d, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    // GoTrue: the refresh endpoint the module posts to.
    if (u.pathname === '/auth/v1/token') { refreshes++; expired = false; return j({ access_token: 'fresh-token', refresh_token: 'r2' }); }
    if (u.pathname === '/api/auth') {
      const v = u.searchParams.get('view');
      if (v === 'config') return j({ supabaseUrl: `http://localhost:8951`, anonKey: 'anon' });
      if (v === 'me') {
        const bearer = (req.headers.authorization || '').replace('Bearer ', '');
        // The stale token is refused ONCE; after a refresh the fresh one works.
        if (bearer === 'stale-token' && expired) return j({ error: 'unauthorized' }, 401);
        return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
      }
      return j({ ok: true });
    }
    if (u.pathname.startsWith('/api/')) return j([]);
    const map = { '/': '/index.html', '/stats': '/stats.html', '/admin': '/admin.html', '/login': '/login.html',
      '/account': '/account.html', '/reports': '/reports.html', '/context': '/context.html' };
    const f = map[u.pathname] || u.pathname;
    try {
      const b = readFileSync(DIR + f);
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
  });
  await new Promise((r) => server.listen(8951, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // 3a. Every page loads the module and has a working afetch. A module served
  //     with the wrong MIME type, or loaded after the inline block, leaves the
  //     page with no afetch at all — and the page still renders, which is why
  //     this is asserted per page rather than once.
  for (const path of ['/', '/stats', '/admin', '/account', '/reports', '/context']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'good', refresh_token: 'r' })));
    await page.goto('http://localhost:8951' + path, { waitUntil: 'networkidle' });
    const shape = await page.evaluate(() => ({
      afetch: typeof afetch, refresh: typeof refreshSession, save: typeof saveSession, hasSession: !!session,
    }));
    assert.deepStrictEqual(shape, { afetch: 'function', refresh: 'function', save: 'function', hasSession: true },
      `${path}: the shared session module is loaded and in scope`);
    // A redeclaration between the module and the page's own block is a
    // SyntaxError that kills the whole inline script.
    assert.deepStrictEqual(errs.filter((e) => /already been declared/i.test(e)), [],
      `${path}: no identifier collision between the module and the page`);
    await page.close();
  }

  // 3b. The refresh actually runs: a stale token gets one silent retry and the
  //     call succeeds. This is the behaviour that was duplicated six ways.
  {
    refreshes = 0; expired = true;
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'stale-token', refresh_token: 'r' })));
    await page.goto('http://localhost:8951/account', { waitUntil: 'networkidle' });
    const out = await page.evaluate(async () => {
      const r = await afetch('/api/auth?view=me');
      return { status: r.status, body: await r.json() };
    });
    assert.strictEqual(out.status, 200, 'a stale token is refreshed and the call succeeds');
    assert.ok(refreshes >= 1, 'the refresh endpoint was actually called');
    // And the NEW token was persisted, so the next page load starts fresh.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pr_session')));
    assert.strictEqual(stored.access_token, 'fresh-token', 'the refreshed token is saved');
    assert.strictEqual(stored.refresh_token, 'r2', 'and so is a rotated refresh token');
    await page.close();
  }

  // 3c. A dead session does NOT loop. One retry, then the 401 reaches the
  //     caller — an unbounded retry would hammer GoTrue on every failed call.
  {
    expired = true;                       // the previous case un-expired it
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'stale-token', refresh_token: '' })));
    await page.goto('http://localhost:8951/account', { waitUntil: 'networkidle' });
    const before = refreshes;
    const status = await page.evaluate(async () => (await afetch('/api/auth?view=me')).status);
    assert.strictEqual(status, 401, 'with no refresh token the 401 reaches the caller');
    assert.strictEqual(refreshes, before, 'and no refresh was attempted');
    await page.close();
  }

  // 3d. signOut clears everything and leaves.
  {
    const page = await browser.newPage();
    // Set storage directly rather than with addInitScript: an init script runs
    // again on the navigation signOut triggers, which would silently re-create
    // the keys this case exists to prove are gone. Staged from /login, because
    // the board bounces a session-less visitor before an evaluate can land.
    await page.goto('http://localhost:8951/login', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      localStorage.setItem('pr_session', JSON.stringify({ access_token: 'good', refresh_token: 'r' }));
      localStorage.setItem('pr_token', 'legacy');   // the pre-Bearer leftover
    });
    // signOut() navigates, so the evaluate's context is torn down mid-call —
    // that IS the behaviour under test, not a failure.
    await page.evaluate(() => signOut()).catch(() => {});
    // We were already ON /login, so waitForURL returns instantly and a plain
    // evaluate races the reload signOut triggers. waitForFunction re-evaluates
    // across navigations, so it settles instead of racing.
    await page.waitForFunction(
      () => localStorage.getItem('pr_session') === null && localStorage.getItem('pr_token') === null,
      null, { timeout: 5000 },
    );
    assert.ok(/\/login/.test(page.url()), `and lands on the sign-in screen (got ${page.url()})`);
    await page.close();
  }

  // 3e. login.html creates the session the other six read — through the same
  //     writer, so the stored shape cannot drift between creator and readers.
  {
    const page = await browser.newPage();
    await page.goto('http://localhost:8951/login', { waitUntil: 'networkidle' });
    const stored = await page.evaluate(() => {
      saveSession({ access_token: 'a', refresh_token: 'b' });
      return JSON.parse(localStorage.getItem('pr_session'));
    });
    assert.deepStrictEqual(stored, { access_token: 'a', refresh_token: 'b' },
      'login writes through the shared saveSession, so the shape matches what every reader expects');
    await page.close();
  }

  await browser.close();
  server.close();
}

console.log('SESSION-SHARED OK — one implementation in /assets/session.js, loaded before every page block; no page redefines it or writes pr_session directly; the refresh runs and persists, a dead session does not loop, sign-out clears the legacy token too, and login writes through the same writer the readers use');
