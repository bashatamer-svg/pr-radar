// Task 14 — subscriber + feedback admin. Mocked Supabase (pr_subscribers,
// pr_feedback) with a tiny in-memory store, exercised via the real endpoint.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'cron';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

let subs = [
  { id: 1, email: 'ceo@vodafone.com', name: 'CEO', categories: null, active: true, created_at: '2026-07-01T00:00:00Z' },
  { id: 2, email: 'cash@vodafone.com', name: 'Cash Lead', categories: ['vodafone_cash'], active: true, created_at: '2026-07-05T00:00:00Z' },
];
let fb = [
  { id: 1, message: 'The board loads slowly on mobile.', kind: 'bug', name: 'Sara', email: 's@x.com', page: '/', user_agent: 'x', created_at: '2026-07-20T00:00:00Z', resolved: false },
  { id: 2, message: 'Add a weekly digest please.', kind: 'idea', name: null, email: null, page: '/', user_agent: 'x', created_at: '2026-07-18T00:00:00Z', resolved: true },
];
let nextSub = 3;

// Minimal PostgREST mock for the tables this endpoint touches.
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const m = opts.method || 'GET';
  const json = (d) => ({ ok: true, text: async () => JSON.stringify(d) });
  const nc = () => ({ ok: true, text: async () => '' });
  if (u.includes('/rest/v1/pr_subscribers')) {
    if (m === 'GET') return json(subs.slice().sort((a, b) => (Number(b.active) - Number(a.active)) || a.id - b.id));
    if (m === 'POST') { const b = JSON.parse(opts.body); const ex = subs.find((s) => s.email === b.email);
      if (ex) { Object.assign(ex, { name: b.name, categories: b.categories, active: true }); return json([ex]); }
      const row = { id: nextSub++, ...b, created_at: new Date().toISOString().replace('Z', 'Z') }; subs.push(row); return json([row]); }
    if (m === 'PATCH') { const id = Number((u.match(/id=eq\.(\d+)/) || [])[1]); const b = JSON.parse(opts.body); const s = subs.find((x) => x.id === id); if (s) Object.assign(s, b); return nc(); }
    if (m === 'DELETE') { const id = Number((u.match(/id=eq\.(\d+)/) || [])[1]); subs = subs.filter((x) => x.id !== id); return nc(); }
  }
  if (u.includes('/rest/v1/pr_feedback')) {
    if (m === 'GET') return json(fb.slice().sort((a, b) => (Number(a.resolved) - Number(b.resolved)) || (b.created_at.localeCompare(a.created_at))));
    if (m === 'PATCH') { const id = Number((u.match(/id=eq\.(\d+)/) || [])[1]); const b = JSON.parse(opts.body); const f = fb.find((x) => x.id === id); if (f) Object.assign(f, b); return nc(); }
  }
  throw new Error('unexpected ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const api = async (method, query, body, headers = { authorization: 'Bearer cron' }) => {
  let code, out; const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, end: () => { code = code || 204; return res; } };
  await handler({ method, query, headers, body }, res);
  return { code, out };
};

// --- API unit checks ---
assert.strictEqual((await api('GET', { view: 'subscribers' }, undefined, { authorization: 'Bearer no' })).code, 401, 'bad token 401');
let r = await api('GET', { view: 'subscribers' });
assert.strictEqual(r.out.length, 2, 'lists subscribers');
r = await api('POST', {}, { email: 'New@Vodafone.com', name: 'New Person', categories: 'network, pricing' });
assert.ok(r.out.ok && r.out.subscriber.email === 'new@vodafone.com', 'add lowercases email');
assert.deepStrictEqual(r.out.subscriber.categories, ['network', 'pricing'], 'categories parsed from CSV');
assert.strictEqual((await api('POST', {}, { email: 'bad' })).code, 400, 'invalid email 400');
assert.strictEqual((await api('PATCH', {}, { id: 1, active: false })).code, 204, 'toggle 204');
assert.strictEqual(subs.find((s) => s.id === 1).active, false, 'toggle persisted');
assert.strictEqual((await api('DELETE', { id: 2 })).code, 204, 'delete 204');
assert.ok(!subs.find((s) => s.id === 2), 'subscriber removed');
// feedback
r = await api('GET', { view: 'feedback' });
assert.strictEqual(r.out.length, 2, 'lists feedback');
assert.strictEqual(r.out[0].resolved, false, 'open feedback first');
assert.strictEqual((await api('PATCH', { resource: 'feedback' }, { id: 1, resolved: true })).code, 204);
assert.strictEqual(fb.find((f) => f.id === 1).resolved, true, 'feedback resolved');

// reset store for the UI test
subs = [{ id: 1, email: 'ceo@vodafone.com', name: 'CEO', categories: null, active: true, created_at: '2026-07-01T00:00:00Z' }];
fb = [{ id: 1, message: 'The board loads slowly on mobile.', kind: 'bug', name: 'Sara', email: 's@x.com', page: '/', user_agent: 'x', created_at: '2026-07-20T00:00:00Z', resolved: false }];
nextSub = 2;

// --- headless admin UI ---
const DIR = new URL('..', import.meta.url).pathname + '/public';
const server = createServer((req, res) => {
  const parts = req.url.split('?'); const path = parts[0]; const q = Object.fromEntries(new URLSearchParams(parts[1] || ''));
  if (path === '/api/admin') { let b = ''; req.on('data', (d) => b += d); req.on('end', async () => { const r = await api(req.method, q, b ? JSON.parse(b) : undefined); res.writeHead(r.code || 200, { 'content-type': 'application/json' }); res.end(r.out ? JSON.stringify(r.out) : ''); }); return; }
  const f = path === '/admin' ? '/admin.html' : (path === '/' ? '/index.html' : path);
  try { const body = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8900, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());   // auto-accept the remove confirm()
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8900/admin', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// subscriber list rendered
assert.strictEqual((await page.$$('.row')).length, 1, 'one subscriber shown');
// add a subscriber via the form
await page.fill('#fEmail', 'new@vodafone.com');
await page.fill('#fName', 'New Person');
await page.fill('#fCats', 'network');
await page.click('#addBtn');
await page.waitForTimeout(300);
assert.strictEqual((await page.$$('.row')).length, 2, 'subscriber added to list');
assert.ok(subs.find((s) => s.email === 'new@vodafone.com'), 'add persisted to store');
// toggle active off
await page.click('.row[data-id="1"] .toggle');
await page.waitForTimeout(150);
assert.strictEqual(subs.find((s) => s.id === 1).active, false, 'toggle off persisted');
// remove the new subscriber
const newId = subs.find((s) => s.email === 'new@vodafone.com').id;
// Name the button rather than trusting its position — the row gained an Edit
// icon beside Remove, and an order-dependent selector silently clicked it.
await page.click(`.row[data-id="${newId}"] .x.del`);
await page.waitForTimeout(200);
assert.ok(!subs.find((s) => s.email === 'new@vodafone.com'), 'remove persisted');

// feedback tab
await page.click('.tab[data-tab="fb"]');
await page.waitForTimeout(200);
assert.ok(await page.$('.fb .kind.bug'), 'feedback bug shown');
await page.click('.fb .btn.ghost');   // mark resolved
await page.waitForTimeout(200);
assert.strictEqual(fb.find((f) => f.id === 1).resolved, true, 'feedback resolved via UI');

await page.click('.tab[data-tab="subs"]'); await page.waitForTimeout(150);
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'admin.png', fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('ALL TASK 14 TESTS PASSED — subscriber CRUD + feedback triage (API + UI)');
