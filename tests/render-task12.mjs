// Task 12 — /context.html editor + /api/context. Mocked Supabase (pr_context).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'cron';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

// The stored doc (server state), mutated by the endpoint's setHouseKnowledge.
let store = { content: 'Vodafone Egypt is the largest operator (~40% share).', updated_at: '2026-07-20T09:00:00Z' };

// Mock Supabase REST used by lib/db.js. getHouseKnowledge → select content;
// houseKnowledgeUpdatedAt → select updated_at; setHouseKnowledge → POST upsert.
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  if (u.includes('/rest/v1/pr_context')) {
    if (opts && opts.method === 'POST') { const b = JSON.parse(opts.body); store = { content: b.content, updated_at: b.updated_at }; return { ok: true, text: async () => '' }; }
    if (u.includes('select=content')) return json([{ content: store.content }]);
    if (u.includes('select=updated_at')) return json([{ updated_at: store.updated_at }]);
    return json([store]);
  }
  throw new Error('unexpected ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/context.js');
const api = async (method, query, body, headers = { authorization: 'Bearer tok' }) => {
  let code, out; const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; } };
  await handler({ method, query, headers, body }, res);
  return { code, out };
};

// --- API unit checks ---
assert.strictEqual((await api('GET', {}, undefined, { authorization: 'Bearer nope' })).code, 401, 'bad token 401');
let g = await api('GET', {});
assert.strictEqual(g.code, 200);
assert.ok(/largest operator/.test(g.out.content), 'GET returns current content');
assert.ok(g.out.max > 0, 'GET returns max');

// PUT saves and round-trips
const put = await api('PUT', {}, { content: 'LIVE ISSUE: Vodafone Cash outage since 06:00 — rate wallet stories high.' }, { authorization: 'Bearer cron' });
assert.strictEqual(put.code, 200);
assert.ok(put.out.ok && put.out.length > 0, 'PUT ok');
g = await api('GET', {});
assert.ok(/Vodafone Cash outage/.test(g.out.content), 'saved content persisted');
// non-string + oversize rejected
assert.strictEqual((await api('PUT', {}, { content: 123 }, { authorization: 'Bearer cron' })).code, 400, 'non-string 400');
assert.strictEqual((await api('PUT', {}, { content: 'x'.repeat(20001) }, { authorization: 'Bearer cron' })).code, 413, 'oversize 413');

// --- headless editor: load, edit, save (server /api/context proxied to handler) ---
const DIR = new URL('..', import.meta.url).pathname + '/public';
const server = createServer((req, res) => {
  const parts = req.url.split('?'); const path = parts[0];
  const q = Object.fromEntries(new URLSearchParams(parts[1] || ''));
  if (path === '/api/context') {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', async () => {
      const r = await api(req.method, q, body ? JSON.parse(body) : undefined, { authorization: 'Bearer cron' });
      res.writeHead(r.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.out));
    });
    return;
  }
  const f = path === '/context' ? '/context.html' : (path === '/' ? '/index.html' : path);
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8898, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8898/context', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// textarea prefilled with current (saved) doc
const val = await page.inputValue('#ta');
assert.ok(/Vodafone Cash outage/.test(val), 'editor prefilled with stored content');
assert.strictEqual(await page.getAttribute('#saveBtn', 'disabled') === '' ? 'disabled' : 'enabled', 'disabled'); // clean → disabled

// edit → Save enables; save → success + persisted
await page.click('#ta');
await page.evaluate(() => { const t = document.querySelector('#ta'); t.value = 'UPDATED: spokesperson change effective today.'; t.dispatchEvent(new Event('input')); });
assert.ok(await page.isEnabled('#saveBtn'), 'Save enabled after edit');
await page.click('#saveBtn');
await page.waitForTimeout(300);
assert.ok(/Vodafone Cash outage/.test(store.content) === false && /spokesperson change/.test(store.content), 'server store updated via editor');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'context.png', fullPage: true });

// gate without a session: redirected to the sign-in page (Task 16 behaviour —
// the old inline "private" gate became the /login redirect)
const p2 = await browser.newPage();
await p2.goto('http://localhost:8898/context', { waitUntil: 'networkidle' });
await p2.waitForTimeout(200);
assert.ok(p2.url().includes('/login'), `no session → redirected to /login (got ${p2.url()})`);

await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 12 TESTS PASSED — GET/PUT round-trip, validation, editor load+edit+save, gate');
