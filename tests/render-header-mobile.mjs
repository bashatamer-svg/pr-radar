// The board header on a phone.
//
// `.ttl` was the only flex:1 child in a row of flex:none ones, so it absorbed
// ALL of the overflow: at 390px it measured 1px against 69px of content and
// rendered the product's own name as "P…" (live, 2 Aug, iPhone). The document
// itself never overflowed, so the existing desktop overflow guards could not
// see it — the damage was entirely inside the flex row.
//
// Pinned here: nothing in the header is silently crushed, the two pills degrade
// TOGETHER (Trends keeping its label while Reports had lost its own read as a
// broken button), and the desktop header still shows the wordmark and labels.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'WE', headline: 'WE corporate note', summary: 's', sentiment: 'neutral', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  if (u.pathname === '/api/auth') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // An ADMIN session: the widest the right-hand cluster ever gets (guide +
    // Admin + Sign out). If the header survives this it survives a viewer.
    res.end(u.searchParams.get('view') === 'me' ? '{"email":"a.long.name@vodafone.com","role":"admin","kind":"user"}' : '{"supabaseUrl":"","anonKey":""}');
    return;
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(DIR + f)); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8974, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8974/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card', { timeout: 5000 });

// Every visible element in the header must have room for its own content. An
// element rendered narrower than it needs is text the user cannot read.
const crushed = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.top *')) {
    // The logo tile clips ON PURPOSE: .sweep is a conic-gradient at inset:-40%,
    // so it is always wider than its box. Decoration, not lost text.
    if (el.closest('.mark')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;          // deliberately hidden
    if (!(el.textContent || '').trim()) continue;           // no text to lose
    if (el.scrollWidth > Math.ceil(r.width) + 1) {
      out.push({ cls: el.className, text: (el.textContent || '').trim().slice(0, 24), need: el.scrollWidth, got: Math.round(r.width) });
    }
  }
  return out;
});
assert.deepStrictEqual(crushed, [], `nothing in the header is squeezed below its content width: ${JSON.stringify(crushed)}`);

// The header must not spill past the viewport either.
const right = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.top > *')].filter((e) => e.getBoundingClientRect().width > 0);
  return Math.max(...els.map((e) => e.getBoundingClientRect().right));
});
assert.ok(right <= 390, `the header's last control fits inside the viewport (right edge ${Math.round(right)}px)`);

// The wordmark and its attribution are both READABLE on a phone — that is the
// point of splitting the header into two rows. A single row could not hold
// them alongside two labelled links and the account cluster.
assert.strictEqual(await page.$eval('.ttl .h1', (e) => e.textContent.trim()), 'PR Radar', 'the product name is shown in full');
const sub = await page.$eval('.ttl .sub', (e) => e.textContent.replace(/\s+/g, ' ').trim());
assert.strictEqual(sub, 'by Regulatory Affairs', `the attribution is shown (got "${sub}")`);
assert.ok(await page.$eval('.ttl .sub', (e) => e.getBoundingClientRect().width > 0), 'and is actually visible, not display:none');

// Both section links say what they ARE. Icon-only pills were indistinguishable
// at a glance and read as broken buttons when only one had a label.
for (const [id, label] of [['trendsLink', 'Trends'], ['reportsLink', 'Reports']]) {
  const el = await page.$eval(`#${id}`, (e) => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), w: e.getBoundingClientRect().width }));
  assert.ok(el.text.includes(label), `${id} shows its name on a phone (got "${el.text}")`);
  assert.ok(el.w > 60, `${id} is a real labelled pill, not an icon square (${Math.round(el.w)}px)`);
}
// The nav is its own row, below the identity row — not competing with it.
const rows = await page.$$eval('.top .trow', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
assert.strictEqual(rows.length, 2, 'the header is two rows');
assert.ok(rows[1] > rows[0], 'nav sits below identity');

await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'board-header-390.png' });

// ── desktop keeps everything, plus the clock ──
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(120);
assert.ok(await page.$eval('.ttl .h1', (e) => e.scrollWidth <= Math.ceil(e.getBoundingClientRect().width) + 1), 'the wordmark is not truncated at desktop width');
assert.ok(await page.$eval('.ttl .sub', (e) => e.scrollWidth <= Math.ceil(e.getBoundingClientRect().width) + 1), 'nor is the attribution');
for (const id of ['trendsLink', 'reportsLink']) {
  assert.ok(await page.$eval(`#${id} .tlabel`, (e) => e.getBoundingClientRect().width > 0), `${id} shows its label at desktop width`);
}
assert.ok(await page.$eval('.clock', (e) => e.getBoundingClientRect().width > 0), 'the clock returns on desktop');

await browser.close(); server.close();
if (errs.length) { console.error('PAGE ERRORS:\n' + errs.join('\n')); process.exit(1); }
console.log('HEADER-MOBILE OK — two rows: at 390px "PR Radar" and "by Regulatory Affairs" are both readable, Trends and Reports are labelled pills, nothing is crushed below its content width, and desktop adds the clock');
