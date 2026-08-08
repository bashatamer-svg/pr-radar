// The provider's send ceiling, and the 80% tripwire.
//
// Why this check exists at all, in live numbers: the shared Resend account sent
// 64 / 70 / 64 messages on 6, 7 and 8 August against a free-tier cap of 100 a
// day. Every alert is one email PER RECIPIENT by design, and the list is ten
// people, so ONE extra alert on a busy day is 10% of the daily quota. Past the
// cap the provider refuses sends — and with the urgent poll running every 15
// minutes, the next refusal is whatever fires next.
//
// The two things most likely to be "tidied" into bugs are pinned first: the
// count must stay ACCOUNT-WIDE (the opposite of deliverability.js next door),
// and an incomplete walk must never read as being under the threshold.
import assert from 'node:assert';

const load = async () => import(`${new URL('..', import.meta.url).pathname}/lib/quota.js?t=${Math.random()}`);

const now = Date.parse('2026-08-08T20:00:00Z');
const iso = (agoH) => new Date(now - agoH * 36e5).toISOString();

// A fake provider: newest-first rows, cursor-paged by `after`, exactly as the
// real one behaves. Records every URL so the walk itself can be asserted.
function provider(rows, { pageSize = 100 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const after = u.searchParams.get('after');
    const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    const page = rows.slice(start, start + pageSize);
    return { ok: true, status: 200, json: async () => ({ data: page }) };
  };
  return calls;
}

const rowsOverHours = (n, spanH, tag = 'r') =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, created_at: iso((i / Math.max(1, n - 1)) * spanH) }));

process.env.RESEND_API_KEY = 're_x';
delete process.env.RESEND_DAILY_CAP;
delete process.env.RESEND_MONTHLY_CAP;
delete process.env.RESEND_COUNT_MAX_PAGES;

// ── 1. ACCOUNT-WIDE, deliberately — the opposite of deliverability.js ───────
// The quota ceiling is shared with the other app, so filtering to RADAR_FROM
// would report a fraction of the usage that will actually refuse our sends.
// Same call the storage check makes with db_size_bytes().
{
  const { countRecentSends } = await load();
  process.env.RADAR_FROM = 'PR Radar <PR.Radar@approvalavengers.com>';
  const rows = [
    { id: 'a', from: 'PR Radar <PR.Radar@approvalavengers.com>', created_at: iso(1) },
    { id: 'b', from: 'Regulatory Radar <Regulatory.Radar@approvalavengers.com>', created_at: iso(2) },
    { id: 'c', from: 'Regulatory Radar <Regulatory.Radar@approvalavengers.com>', created_at: iso(3) },
  ];
  provider(rows);
  const r = await countRecentSends({ now });
  assert.strictEqual(r.day, 3,
    `the OTHER app's sends count too — they spend the same quota (got ${r.day}, would be 1 if wrongly scoped to RADAR_FROM)`);
  delete process.env.RADAR_FROM;
}

// ── 2. Both windows come out of ONE backward walk ──────────────────────────
{
  const { countRecentSends } = await load();
  // 40 in the last 24h, 300 more spread across the rest of the month, 50 older
  // than 30 days that must not be counted at all.
  // Deliberately no row ON a boundary — the window edges are `>=`, and a
  // fixture that straddles one tests the fixture, not the counter.
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, created_at: iso(0.5 + i * 0.5) })),        // 0.5h–20h
    ...Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, created_at: iso(25 + i * 2) })),          // 25h–24.9d
    ...Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, created_at: iso(31 * 24 + i) })),          // past 30d
  ];
  const calls = provider(rows);
  const r = await countRecentSends({ now });
  assert.strictEqual(r.day, 40, `24h count (got ${r.day})`);
  assert.strictEqual(r.month, 340, `30d count excludes the 50 older rows (got ${r.month})`);
  assert.ok(r.complete, 'the walk reached past 30 days, so both figures are exact');
  assert.ok(calls.length >= 4, `paged rather than reading only the first 100 (got ${calls.length} request(s))`);
  assert.ok(calls[0].includes('limit=100') && !calls[0].includes('after='), 'the first request carries no cursor');
  assert.ok(calls[1].includes('after='), 'later requests page backwards with a cursor');
}

// ── 3. 80% warns, 95% crits, on WHICHEVER window is worse ──────────────────
{
  const { emailQuotaCheck } = await load();
  const at = (day, month) => emailQuotaCheck({ day, month, complete: true, pages: 3, undated: 0 });

  assert.strictEqual(at(68, 2000).state, 'ok', 'the live shape (68/100, 2000/3000) is not yet a warning');
  assert.strictEqual(at(79, 100).state, 'ok', '79% is below the line');
  assert.strictEqual(at(80, 100).state, 'warn', '80% of the DAILY cap warns — the threshold that was asked for');
  assert.strictEqual(at(10, 2400).state, 'warn', '80% of the MONTHLY cap warns on its own, with a quiet day');
  assert.strictEqual(at(95, 100).state, 'crit', '95% is crit: one ten-recipient alert crosses the cap from there');
  assert.strictEqual(at(120, 100).state, 'crit', 'over the cap stays crit rather than wrapping to something odd');

  const warned = at(85, 100);
  assert.match(warned.detail, /85 of 100 in 24h \(85%\)/, `detail names the 24h figure (got ${warned.detail})`);
  assert.match(warned.detail, /of 3000 in 30d/, 'and the 30d figure');
  assert.match(warned.detail, /whole account/i, 'and says the number is account-wide, so nobody reads it as PR Radar alone');
  assert.match(warned.hint, /per recipient/i, 'the hint explains why one alert is expensive');
}

// ── 4. An incomplete walk is a FLOOR, and a floor can only push the state UP ─
// The dangerous direction is a truncated count reading as "under the line".
{
  const { emailQuotaCheck } = await load();
  const short = emailQuotaCheck({ day: 40, month: 1200, complete: false, pages: 12, undated: 0 });
  assert.match(short.detail, /≥1200 of 3000/, `an incomplete month is marked as a floor (got ${short.detail})`);
  assert.match(short.hint, /FLOOR/, 'and the hint says so in words');
  assert.match(short.hint, /only push this check UP, never down/i,
    'and states the direction of the error, so an ok is not read as a clean month');
  // A floor already over the line still condemns.
  assert.strictEqual(emailQuotaCheck({ day: 1, month: 2900, complete: false, pages: 30, undated: 0 }).state, 'crit',
    'a floor above the crit line is still crit — the true number is at least that');
}

// ── 5. A runaway provider cannot invent a quota crisis ─────────────────────
// Cursor paging can only go one way. A provider that ignored the cursor would
// hand back page one forever, and 34 identical pages counted 34 times reads as
// an emergency that is not happening.
{
  const { countRecentSends } = await load();
  const page = rowsOverHours(100, 20, 'x');
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ data: page }) }; };
  const r = await countRecentSends({ now });
  assert.strictEqual(calls, 2, `the walk stops as soon as the cursor fails to advance (made ${calls} request(s))`);
  assert.strictEqual(r.day, 100, `each message counted once, not once per page (got ${r.day})`);
  assert.ok(!r.complete, 'and it reports the count as incomplete rather than exact');
}

// ── 6. The page budget is bounded ──────────────────────────────────────────
{
  process.env.RESEND_COUNT_MAX_PAGES = '5';
  const { countRecentSends } = await load();
  provider(rowsOverHours(4000, 29 * 24, 'big'));
  const r = await countRecentSends({ now });
  assert.strictEqual(r.pages, 5, `stops at the budget (got ${r.pages})`);
  assert.ok(!r.complete, 'and says the answer is a floor');
  delete process.env.RESEND_COUNT_MAX_PAGES;
}

// ── 6b. …and so is the WALL CLOCK, which is the one that matters ───────────
// Paging is sequential by construction, so a month is ~20 round trips, and
// api/alerts.js has no maxDuration override — it runs on the platform default.
// A quota check that times out the health page has destroyed more than the
// blindness it fixed. Same rule as lib/runs.js: never fail the job you watch.
{
  const { countRecentSends } = await load();
  provider(rowsOverHours(4000, 29 * 24, 'slow'));
  let t = 0;
  const clock = () => (t += 1200); // each consultation "costs" 1.2s
  const r = await countRecentSends({ now, budgetMs: 5000, clock });
  assert.ok(r.pages >= 2 && r.pages <= 6,
    `the walk gives up inside its time budget instead of running to the page cap (got ${r.pages} pages of 34)`);
  assert.ok(!r.complete, 'and reports a floor rather than a number it did not finish counting');
  assert.ok(r.day > 0, 'the 24h figure still lands — it settles on the first page, which is always paid for');
}

// ── 7. Fail-soft, and 'unknown' never reads as 'fine' ──────────────────────
{
  const { countRecentSends, emailQuotaCheck } = await load();

  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const denied = await countRecentSends({ now });
  assert.match(denied.error, /send-only/, 'a 401 names the likeliest cause rather than the status alone');
  const c = emailQuotaCheck(denied);
  assert.strictEqual(c.state, 'unknown', 'and the check reports unknown, never ok');
  assert.match(c.hint, /full-access API key/, 'with the console fix, which is not a code change');

  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const down = await countRecentSends({ now });
  assert.match(down.error, /ECONNRESET/, 'a network failure returns its reason, not a bare null');
  assert.strictEqual(emailQuotaCheck(down).state, 'unknown', 'still unknown');
  assert.match(emailQuotaCheck(down).hint, /REFUSES/,
    'and the hint says what is at stake, so unknown is not mistaken for healthy');

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) });
  assert.match((await countRecentSends({ now })).error, /unexpected response shape/, 'a shape change is named');
}

// ── 8. A cap that would silently read healthy is refused ───────────────────
// 0 or a negative would make the usage percentage meaningless-or-negative, and
// a ceiling check that reads green because its ceiling is broken is the one
// failure this whole file exists to prevent.
{
  for (const bad of ['0', '-5', 'lots', '']) {
    process.env.RESEND_DAILY_CAP = bad;
    const { caps, emailQuotaCheck } = await load();
    assert.strictEqual(caps().day, 100, `RESEND_DAILY_CAP=${JSON.stringify(bad)} falls back to the documented default`);
    assert.strictEqual(emailQuotaCheck({ day: 90, month: 0, complete: true, pages: 1, undated: 0 }).state, 'warn',
      `and 90 sends still warns with RESEND_DAILY_CAP=${JSON.stringify(bad)}`);
  }
  delete process.env.RESEND_DAILY_CAP;
}

// ── 9. A real plan overrides the free-tier default, and the note disappears ─
{
  process.env.RESEND_DAILY_CAP = '5000';
  process.env.RESEND_MONTHLY_CAP = '50000';
  const { emailQuotaCheck } = await load();
  const c = emailQuotaCheck({ day: 68, month: 2000, complete: true, pages: 20, undated: 0 });
  assert.strictEqual(c.state, 'ok', 'the same traffic is comfortable on a bigger plan');
  assert.ok(!/free tier/.test(c.hint), 'and the check stops explaining a default it is no longer using');
  delete process.env.RESEND_DAILY_CAP;
  delete process.env.RESEND_MONTHLY_CAP;
}

// ── 10. On the defaults, the check SAYS they are assumed ───────────────────
// The provider exposes no plan endpoint, so these numbers are a configuration
// guess. A check that quietly presents a guess as a measurement is how someone
// on a bigger plan spends a morning on a warning that means nothing.
{
  const { emailQuotaCheck } = await load();
  const c = emailQuotaCheck({ day: 68, month: 2000, complete: true, pages: 20, undated: 0 });
  assert.match(c.hint, /free tier/i, 'the default caps are declared as an assumption');
  assert.match(c.hint, /RESEND_DAILY_CAP/, 'and the check names the variable that corrects them');
}

console.log('EMAIL-QUOTA OK — account-wide by design, both windows from one walk, 80% warns and 95% crits on the worse window, an incomplete walk is an honest floor, a stuck cursor cannot invent a crisis, and a broken cap falls back rather than reading green');
