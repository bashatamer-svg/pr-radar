// Attribution is never blank: person byline when present, else "<Outlet> · newsroom"
// (display-only — the DB author stays null). Board card (headless) + email cards (unit).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.BOARD_URL = 'https://pr.example/';

// ── email cards (unit) ──
const { renderBulletin, renderUrgent } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');
const now = new Date().toISOString();
const withAuthor = { id: 1, brand: 'Vodafone', headline: 'Story A', sentiment: 'negative', importance: 4, category: 'network', url: 'u', published_at: now, author: 'Sara Fahmy', source: 'Masrawy', _instances: [{ outlet: 'Masrawy', author: 'Sara Fahmy', url: 'u' }] };
const noAuthor = { id: 2, brand: 'Vodafone', headline: 'Story B', sentiment: 'neutral', importance: 3, category: 'corporate', url: 'u', published_at: now, author: null, source: 'Youm7', _instances: [{ outlet: 'Youm7', author: null, url: 'u' }] };
const bare = { id: 3, brand: 'Orange', headline: 'Story C', sentiment: 'neutral', importance: 2, category: 'other', url: 'u', published_at: now, author: null, source: null };

const bulletin = renderBulletin({ items: [withAuthor, noAuthor, bare], broken: [], scanned: 10 });
assert.ok(bulletin.includes('By Sara Fahmy'), 'email: person byline shown');
// The email and the board answer "who wrote this?" differently ON PURPOSE.
// The board has a `.by` field of its own, so "Youm7 · newsroom" belongs there.
// The email card puts the byline in a meta line that already opens with the
// outlet, so the newsroom fallback printed it twice — "Youm7 · 2h ago · Youm7 ·
// newsroom" — which reads as a rendering bug. Here an absent byline is simply
// absent. Nothing is invented in either surface, which is the actual rule.
assert.ok(!/Youm7 · newsroom/.test(bulletin), 'email: no redundant newsroom tail beside the outlet');
assert.ok(!/By Youm7/.test(bulletin), 'never fakes the outlet as a person ("By Youm7")');
assert.ok(!/Author —/.test(bulletin), 'email: an unknown byline is omitted, not spelled out');
// ...and the outlet is still named once, so the card is not left anonymous.
assert.ok(/>Youm7</.test(bulletin), 'email: the outlet still appears in the meta line');
const urgent = renderUrgent(noAuthor, process.env.BOARD_URL);
assert.ok(!/Youm7 · newsroom/.test(urgent) && /Youm7/.test(urgent), 'urgent email: same rule');
assert.ok(/By Sara Fahmy/.test(renderUrgent(withAuthor, process.env.BOARD_URL)), 'urgent email: person byline shown');

// ── board card (headless) ──
const DIR = new URL('..', import.meta.url).pathname + '/public';
const items = [
  { ...withAuthor, instances: withAuthor._instances },
  { ...noAuthor, instances: noAuthor._instances },
  { ...bare, instances: [] },
];
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/auth') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(u.searchParams.get('view') === 'me' ? '{"email":"a@b.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}'); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8919, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8919/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 4000 });

assert.strictEqual(await page.$eval('#item-1 .by', el => el.textContent), 'By Sara Fahmy', 'board: person byline');
assert.strictEqual(await page.$eval('#item-2 .by', el => el.textContent), 'Youm7 · newsroom', 'board: newsroom fallback');
assert.ok(await page.$eval('#item-2 .by', el => el.classList.contains('desk')), 'board: fallback styled as desk');
assert.strictEqual(await page.$eval('#item-3 .by', el => el.textContent), 'Author —', 'board: no outlet at all → dash');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('DESK-BYLINE OK — board + bulletin + urgent: person byline when present, "<Outlet> · newsroom" when not, honest dash only when no outlet either; never fakes a person');
