// Admin → Health, in a real browser: the tab that answers "is the radar
// working right now".
//
// What is worth pinning here is presentation, because that is where a health
// page fails silently:
//   * a problem must be visible from ANOTHER tab (the badge), or you only find
//     out when you thought to go looking — which is too late;
//   * every check must render its state, not just its text, so the page can be
//     read at a glance rather than word by word;
//   * an 'unknown' from a table that was never migrated must SAY that, and must
//     not be dressed up as an all-clear;
//   * the alert history must distinguish "not switched on" from "nothing has
//     gone wrong", because those look identical if you print an empty list.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const iso = '2026-08-01T04:15:00Z';

// A realistic mid-state: mostly fine, one warn, one crit, two unknown because
// the optional tables are not migrated — which is production's actual shape.
let health = {
  generatedAt: '2026-08-02T09:00:00Z',
  status: 'crit',
  logAvailable: true,
  log: [{ kind: 'ops', severity: 'critical', title: 'PR Radar health: Classification, Brief recipients',
          detail: 'Classification: 25 story(s) parked unclassified in 48h', created_at: iso }],
  checks: [
    { id: 'bulletin', label: 'Daily brief', state: 'ok', detail: 'last sent 4.0h ago · 4 story(s) currently clear the Impact-2 bar' },
    { id: 'ingest', label: 'Feed ingest', state: 'ok', detail: 'last new story 1.0h ago · 69 stored / 2 relevant in 24h' },
    { id: 'classify', label: 'Classification', state: 'crit', detail: '25 story(s) parked unclassified in 48h',
      hint: 'The model returned no verdict for these, so they are hidden from the board and the brief.' },
    { id: 'recipients', label: 'Brief recipients', state: 'warn', detail: '5 subscriber(s)',
      hint: 'RADAR_TO is unset, so the team/admin copy of the brief does not go out.' },
    { id: 'feeds', label: 'Feed health', state: 'ok', detail: 'all feeds reporting' },
    { id: 'quality', label: 'Screening quality', state: 'ok', detail: '6.0% relevant over 7d (42/700) vs 6.0% over the previous 3 weeks' },
    { id: 'authors', label: 'Byline backfill', state: 'ok', detail: '31 of 73 cards without a byline in 14d (42.5%)' },
    { id: 'weekly', label: 'Weekly report email', state: 'ok', detail: 'off — the Monday cron runs and returns without sending' },
    { id: 'spend', label: 'API spend', state: 'unknown', detail: 'usage tracking not available (pr_usage not migrated)' },
    { id: 'inbox', label: 'Deliverability', state: 'ok', detail: '5 accepted and delivered (26h)' },
    { id: 'storage', label: 'Storage headroom', state: 'ok', detail: '22 MB of 500 MB (4%) — whole project, shared with another app' },
    { id: 'cache', label: 'Prompt cache', state: 'unknown', detail: 'not enough cached calls in 24h to judge' },
  ],
};

let alertsHits = 0;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/api/auth') {
    if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
    return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
  }
  if (u.pathname === '/api/alerts') { alertsHits++; return j(health); }
  if (u.pathname === '/api/admin') return j([]);   // every other tab is empty here
  const f = u.pathname === '/admin' ? '/admin.html' : (u.pathname === '/' ? '/index.html' : u.pathname);
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8911, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
await page.goto('http://localhost:8911/admin', { waitUntil: 'networkidle' });
await page.waitForSelector('#tabs:not([hidden])', { timeout: 5000 });

/* 1 ── the badge warns you from a tab you are already on ─────────────────── */
{
  // The board opens on Subscribers. If a problem is only visible once you think
  // to open Health, the page has already failed at its job.
  await page.waitForFunction(() => document.querySelector('#nHealth')?.textContent, null, { timeout: 5000 });
  const badge = await page.textContent('#nHealth');
  assert.strictEqual(badge, '2', `the Health tab badges the 2 failing checks while you are on Subscribers (got "${badge}")`);
  const tab = await page.getAttribute('.tab[data-tab="health"]', 'aria-pressed');
  assert.strictEqual(tab, 'false', 'and it has not stolen focus from the tab you opened');
}

/* 2 ── every check renders its STATE, not only its words ─────────────────── */
{
  await page.click('.tab[data-tab="health"]');
  await page.waitForSelector('.chk', { timeout: 5000 });

  const n = await page.$$eval('.chk', (els) => els.length);
  assert.strictEqual(n, 12, `all twelve checks render (got ${n})`);

  const states = await page.$$eval('.chk', (els) => els.map((e) => ({
    name: e.querySelector('.cname').textContent,
    cls: [...e.classList].find((c) => c.startsWith('s-')),
    pill: e.querySelector('.pill').textContent,
  })));
  const find = (label) => states.find((s) => s.name === label);
  assert.strictEqual(find('Classification').cls, 's-crit', 'a crit check is spined crit');
  assert.strictEqual(find('Classification').pill, 'critical', 'and pilled "critical" in words as well as colour');
  assert.strictEqual(find('Brief recipients').cls, 's-warn', 'a warn check is spined warn');
  assert.strictEqual(find('Feed ingest').cls, 's-ok', 'a healthy check is spined ok');

  // The two unknowns must NOT be dressed as green. A page that shows a
  // never-migrated table as "all clear" is worse than showing nothing.
  assert.strictEqual(find('API spend').cls, 's-unknown', 'an unmeasurable check is unknown, not ok');
  assert.strictEqual(find('API spend').pill, 'unknown', 'and says unknown');
  assert.match(await page.textContent('.chk.s-unknown .cdetail'), /not migrated/,
    'and names the reason, so it reads as "not switched on" rather than "broken"');

  const banner = await page.getAttribute('.hbanner', 'class');
  assert.match(banner, /s-crit/, 'the page banner takes the worst check');
  assert.match(await page.textContent('.hbanner'), /Action needed/, 'in plain words, not a colour alone');
}

/* 3 ── hints are shown, and server-supplied text can't inject markup ─────── */
{
  const hints = await page.$$eval('.chint', (els) => els.map((e) => e.textContent));
  assert.ok(hints.some((h) => /hidden from the board/.test(h)), 'a failing check explains what it means');
  assert.ok(hints.some((h) => /RADAR_TO is unset/.test(h)), 'and what to do about it');

  // Check text is assembled from DB values and env — a feed id, a provider
  // status string. None of it is trusted markup.
  health = { ...health, checks: [{ id: 'feeds', label: 'Feed health', state: 'warn',
    detail: '1 feed(s) with no success in 3+ days', hint: '<img src=x onerror="window.__pwned=1">' }] };
  await page.click('#hRefresh');
  await page.waitForFunction(() => document.querySelectorAll('#hChecks .chk').length === 1, null, { timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, 'check text is escaped, never parsed as HTML');
  assert.match(await page.textContent('.chint'), /onerror/, 'and is shown literally instead of being dropped');
}

/* 4 ── history distinguishes "off" from "nothing wrong" ──────────────────── */
{
  health = { ...health, checks: [], log: [{ kind: 'ops', severity: 'critical',
    title: 'PR Radar health: Classification, Brief recipients',
    detail: 'Classification: 25 story(s) parked unclassified in 48h', created_at: iso }], logAvailable: true };
  await page.click('#hRefresh');
  await page.waitForSelector('.alog', { timeout: 5000 });
  assert.match(await page.textContent('.alog .at'), /Classification, Brief recipients/,
    'a logged alert names the checks that were failing at the time');
  assert.match(await page.textContent('.alog pre'), /parked unclassified/, 'and keeps the detail for later');

  // Nothing wrong in 14 days.
  health = { ...health, log: [], logAvailable: true };
  await page.click('#hRefresh');
  await page.waitForFunction(
    () => /No alerts in the last 14 days/.test(document.querySelector('#hLog')?.textContent || ''),
    null, { timeout: 5000 });

  // History not switched on at all — must say so, and point at the migration.
  health = { ...health, log: [], logAvailable: false };
  await page.click('#hRefresh');
  await page.waitForFunction(
    () => /2026-08-02-pr-alerts\.sql/.test(document.querySelector('#hLog')?.textContent || ''),
    null, { timeout: 5000 });
  assert.match(await page.textContent('#hLog'), /isn't switched on yet/,
    'it says the history is off, rather than printing an empty list that reads as "nothing has gone wrong"');
}

/* 5 ── re-opening the tab re-checks; a cached verdict answers the wrong question */
{
  const before = alertsHits;
  await page.click('.tab[data-tab="subs"]');
  await page.waitForSelector('#fEmail', { timeout: 5000 });     // Subscribers rendered
  await page.click('.tab[data-tab="health"]');
  await page.waitForSelector('#hLog', { timeout: 5000 });
  assert.ok(alertsHits > before, `re-opening Health re-runs the checks (${before} → ${alertsHits})`);
}

assert.deepStrictEqual(errs, [], `no page errors: ${errs.join(' | ')}`);
await browser.close();
server.close();
console.log('HEALTH-TAB OK — 12 checks render with their state, the badge surfaces failures from another tab, '
  + 'unknown is never dressed as ok, history separates "not switched on" from "nothing wrong", and re-opening re-checks');
