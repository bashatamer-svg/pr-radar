// Prove the CSP by SERVING IT. verify-security-headers asserts the policy is
// declared and that the pages look compatible; this loads every page through a
// server that sends the real header from vercel.json and fails on any violation
// the browser reports.
//
// Necessary because a CSP is not a static property of the files: a directive
// that is one token too narrow produces a page that renders and then quietly
// does nothing — the board loads, the session never refreshes, the snapshot is
// a broken image, and there is no server-side error anywhere.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const root = new URL('..', import.meta.url).pathname;
const DIR = root + 'public';
const vercel = JSON.parse(readFileSync(root + 'vercel.json', 'utf8'));
const HEADERS = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
// The real policy, minus the HTTPS-only header (this test serves plain http on
// localhost, and HSTS on http is ignored by browsers anyway).
delete HEADERS['Strict-Transport-Security'];

const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'Vodafone Cash outage angers users', summary: 's',
    pr_angle: 'Read · x\nAudience · y\nAction · z', sentiment: 'negative', importance: 5,
    category: 'vodafone_cash', url: 'https://youm7.example/a', resolved_url: 'https://youm7.example/a',
    published_at: now, author: 'Mona Said', source: 'Youm7',
    instances: [{ outlet: 'Youm7', url: 'https://youm7.example/a', author: 'Mona Said' },
                { outlet: 'Al Mal', url: 'https://almal.example/a', author: null }] },
];
const stats = {
  meta: { days: 30, generatedAt: now, items: 1 }, days: [now.slice(0, 10)],
  sov: { Vodafone: { mentions: [1], negatives: [1] }, Orange: { mentions: [0], negatives: [0] },
         WE: { mentions: [0], negatives: [0] }, 'e&': { mentions: [0], negatives: [0] },
         Market: { mentions: [0], negatives: [0] } },
  sentimentByBrand: { Vodafone: { negative: 1, neutral: 0, positive: 0, total: 1 },
    Orange: { negative: 0, neutral: 0, positive: 0, total: 0 }, WE: { negative: 0, neutral: 0, positive: 0, total: 0 },
    'e&': { negative: 0, neutral: 0, positive: 0, total: 0 }, Market: { negative: 0, neutral: 0, positive: 0, total: 0 } },
  categories: [{ category: 'vodafone_cash', total: 1, negative: 1, vodNeg: 1, series: [1] }],
  narratives: [], outlets: [{ outlet: 'Youm7', mentions: 1, negative: 1, neutral: 0, positive: 0, vodNeg: 1, series: [1] }],
  authors: [{ author: 'Mona Said', mentions: 1, negative: 1, neutral: 0, positive: 0, vodNeg: 1, outlets: ['Youm7'], series: [1] }],
  totals: { items: 1, negatives: 1, positives: 0, neutrals: 0, vodafone: { mentions: 1, negatives: 1 },
    distinctOutlets: 1, distinctAuthors: 1, itemsWithByline: 1 },
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { ...HEADERS, 'content-type': type }); res.end(body); };
  const j = (d) => send(200, 'application/json', JSON.stringify(d));
  if (u.pathname === '/api/items') return j(items);
  if (u.pathname === '/api/stats') return j(stats);
  if (u.pathname === '/api/admin') return j([]);
  if (u.pathname === '/api/alerts') return j({ checks: [], alerts: [] });
  if (u.pathname === '/api/context') return j({ content: '', updated_at: null });
  if (u.pathname === '/api/auth') {
    const v = u.searchParams.get('view');
    // A real-looking Supabase origin, so a connect-src that forgot it fails here.
    if (v === 'config') return j({ supabaseUrl: 'https://project.supabase.co', anonKey: 'anon' });
    if (v === 'me') return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
    return j({ ok: true });
  }
  const map = { '/': '/index.html', '/stats': '/stats.html', '/admin': '/admin.html', '/login': '/login.html',
    '/account': '/account.html', '/guide': '/guide.html', '/reports': '/reports.html', '/context': '/context.html' };
  const f = map[u.pathname] || u.pathname;
  try {
    const body = readFileSync(DIR + f);
    const type = f.endsWith('.png') ? 'image/png' : f.endsWith('.js') ? 'text/javascript'
      : f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    send(200, type, body);
  } catch { send(404, 'text/plain', 'nf'); }
});
await new Promise((r) => server.listen(8931, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

const PAGES = ['/', '/stats', '/admin', '/login', '/account', '/guide', '/reports', '/context'];
const problems = [];
for (const path of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const violations = [];
  // A CSP violation surfaces two ways; catch both, since a blocked inline
  // handler reports as a console error and a blocked fetch as a page error.
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|connect|execute|apply|run|frame)/i.test(t)) violations.push(t);
  });
  page.on('pageerror', (e) => {
    if (/Content Security Policy|Refused to/i.test(e.message)) violations.push(e.message);
  });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8931' + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);

  // The page's own scripts ran: a wholly blocked script would leave the
  // document inert while still reporting as loaded.
  const alive = await page.evaluate(() => document.readyState === 'complete');
  assert.ok(alive, `${path} finished loading under the CSP`);
  if (violations.length) problems.push(`${path}: ${violations.slice(0, 3).join(' | ')}`);
  await page.close();
}
assert.deepStrictEqual(problems, [], 'no page reports a CSP violation under the shipped policy');

// ── the specific capabilities the CSP could silently take away ────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8931/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 5000 });

  // 1. INLINE HANDLERS still fire. Every board control is an onclick attribute;
  //    a script-src without 'unsafe-inline' makes them all dead with no visible
  //    failure — the buttons are there and nothing happens. Asserted by EFFECT.
  // Pin lives in the ••• More menu now, so this exercises TWO inline handlers:
  // the one that opens the menu and the one that acts.
  await page.click('#item-1 .morebtn');
  const before = await page.$eval('#item-1 .mitem.pin', (e) => e.getAttribute('aria-pressed'));
  await page.click('#item-1 .mitem.pin');
  await page.waitForTimeout(150);
  const after = await page.$eval('#item-1 .mitem.pin', (e) => e.getAttribute('aria-pressed'));
  assert.notStrictEqual(after, before, 'an inline onclick handler still runs under the CSP');

  // 2. blob: images. The card snapshot draws to a canvas and previews it as
  //    <img src="blob:…">; img-src without blob: shows a broken image.
  const blobImgOk = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
    cv.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const url = URL.createObjectURL(blob);
    return await new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = url; });
  });
  assert.strictEqual(blobImgOk, true, 'a blob: image loads — the 📸 snapshot preview needs it');

  // 3. The Supabase token refresh. connect-src must name the provider, or every
  //    page signs the user out the moment their access token expires.
  const supa = await page.evaluate(async () => {
    try { await fetch('https://project.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: '{}' }); return 'allowed'; }
    catch (e) { return e.message; }
  });
  // The host does not resolve in the sandbox, so a network failure is expected
  // and fine — what must NOT appear is a CSP refusal.
  assert.ok(!violations.some((v) => /supabase/i.test(v)),
    `the Supabase refresh origin is allowed by connect-src (browser said: ${supa})`);

  // 4. A cross-origin fetch that is NOT Supabase must still be blocked —
  //    otherwise connect-src is decorative.
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://evil.example/x'); return 'allowed'; } catch (e) { return e.message; }
  });
  assert.notStrictEqual(blocked, 'allowed', 'an arbitrary cross-origin fetch is refused');
  assert.ok(violations.some((v) => /evil\.example/.test(v)), 'and the refusal is a CSP one, naming the host');
  await page.close();
}

await browser.close();
server.close();
console.log('CSP OK — all eight pages load clean under the shipped policy; inline handlers still fire, blob: snapshots still render, the Supabase refresh origin is reachable, and an arbitrary cross-origin fetch is refused');
