// Trends must not wait on an LLM.
//
// /api/stats used to `await buildNarratives()` inline, and that awaits Anthropic
// with a 12-second ceiling (NARRATIVE_TIMEOUT_MS). Trends is a PAGE LOAD, so on
// a cold request every chart on the screen — share of voice, sentiment,
// categories, both leaderboards, the KPI row — waited on an LLM that contributes
// exactly one card. The whole screen was as slow as its slowest optional part.
//
// The split: the main call returns the DETERMINISTIC token clustering (stage 1,
// which runs either way, so it is free) and the browser asks for the LLM
// regrouping separately. What must hold:
//   1. /api/stats makes ZERO Anthropic calls, whatever the key says
//   2. the narrative card is populated on FIRST PAINT, not empty-then-filled
//   3. ?view=narratives does run the model, and returns the same row shape
//   4. deep-link integrity survives the move (ids, idsTotal, the NARR_IDS_MAX cap)
//   5. a failed or slow upgrade leaves the grouping already on screen
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + 'public';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.CRON_SECRET = 'cron';
process.env.ANTHROPIC_API_KEY = 'sk-test';        // the model is CONFIGURED…

const now = new Date();
const iso = (d) => new Date(now.getTime() - d * 864e5).toISOString();
// Two clear themes, several stories each, so both the token pass and the model
// have something real to group.
const ITEMS = [];
let id = 1;
for (let i = 0; i < 6; i++) ITEMS.push({ id: id++, brand: 'Vodafone', sentiment: 'negative', category: 'vodafone_cash',
  headline: `Vodafone Cash outage hits users again ${i}`, summary: `Vodafone Cash service outage complaints ${i}`,
  published_at: iso(i % 5), seen_at: iso(i % 5), source: 'Youm7', author: 'Mona Said', is_relevant: true, importance: 4 });
for (let i = 0; i < 5; i++) ITEMS.push({ id: id++, brand: 'Orange', sentiment: 'positive', category: 'campaign',
  headline: `Orange Egypt launches new campaign ${i}`, summary: `Orange Egypt marketing campaign launch ${i}`,
  published_at: iso(i % 5), seen_at: iso(i % 5), source: 'Al Mal', author: null, is_relevant: true, importance: 2 });

let anthropicCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    anthropicCalls++;
    // Regroup into two named narratives, using the real ids it was given.
    const body = JSON.parse(opts.body);
    const text = JSON.stringify(body).match(/"id":\s*(\d+)/g) || [];
    const seen = [...JSON.stringify(body).matchAll(/\b(\d+)\s*[:|]/g)].map((m) => Number(m[1]));
    const vod = ITEMS.filter((i) => i.brand === 'Vodafone').map((i) => i.id);
    const orange = ITEMS.filter((i) => i.brand === 'Orange').map((i) => i.id);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify([
      { title: 'Vodafone Cash outages', ids: vod },
      { title: 'Orange campaign push', ids: orange },
    ]) }] }) };
  }
  if (u.includes('pr_items')) return { ok: true, status: 200, text: async () => JSON.stringify(ITEMS) };
  if (u.includes('pr_instances')) return { ok: true, status: 200, text: async () => '[]' };
  if (u.includes('pr_users')) return { ok: true, status: 200, text: async () => '[]' };
  return { ok: true, status: 200, text: async () => '[]' };
};

const { default: stats } = await import('../api/stats.js');
const { NARR_IDS_MAX, _resetNarrativeCache } = await import('../lib/narratives.js');

const call = async (query) => {
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end: () => res };
  await stats({ method: 'GET', query, headers: { authorization: 'Bearer cron' } }, res);
  return { code, body };
};

/* ── 1. the main call never touches the model ───────────────────────────── */
{
  _resetNarrativeCache();
  anthropicCalls = 0;
  const { code, body } = await call({ days: '30' });
  assert.strictEqual(code, 200);
  assert.strictEqual(anthropicCalls, 0,
    `/api/stats made ${anthropicCalls} Anthropic call(s) — the charts must never wait on the model`);

  // …and it is NOT because the key is missing. It is configured above; the
  // endpoint simply does not use it. Otherwise this test would pass for the
  // wrong reason on any machine without a key, which is every machine here.
  assert.ok(process.env.ANTHROPIC_API_KEY, 'the model IS configured — the endpoint just does not call it');

  // 2. The card is populated on first paint. An empty narratives array would
  //    mean the split traded a slow card for a missing one.
  assert.ok(Array.isArray(body.narratives) && body.narratives.length > 0,
    'the deterministic clustering ships with the main payload, so the card has content immediately');
  assert.strictEqual(body.narrativesPending, true, 'and it says a better grouping is worth asking for');

  // Everything else the screen draws is still there and unaffected.
  for (const k of ['sov', 'sentimentByBrand', 'categories', 'outlets', 'authors', 'totals', 'days']) {
    assert.ok(body[k], `${k} still ships with the main payload`);
  }
  assert.strictEqual(body.totals.items, ITEMS.length, 'the aggregates are unchanged');
}

/* ── 2. no key ⇒ nothing to ask for ─────────────────────────────────────── */
{
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const { body } = await call({ days: '30' });
  assert.strictEqual(body.narrativesPending, false,
    'with no API key the browser is told not to bother — a request that can only return what it already has');
  assert.ok(body.narratives.length > 0, 'and the clustering is still there, so the card still works');
  process.env.ANTHROPIC_API_KEY = key;
}

/* ── 3. ?view=narratives does run the model, and returns the same shape ── */
{
  _resetNarrativeCache();
  anthropicCalls = 0;
  const { code, body } = await call({ days: '30', view: 'narratives' });
  assert.strictEqual(code, 200);
  assert.strictEqual(anthropicCalls, 1, `the narratives view calls the model exactly once (got ${anthropicCalls})`);
  assert.ok(body.narratives.length >= 2, 'and returns the regrouped narratives');
  assert.ok(body.narratives.some((n) => /Vodafone Cash outages/.test(n.name)),
    'with the model\'s titles, which is the whole reason for the second call');

  // It returns ONLY narratives. Re-running the leaderboards and the day axis
  // for a card that needs neither is work the first call already did.
  assert.strictEqual(body.outlets, undefined, 'the narratives view ships no leaderboards');
  assert.strictEqual(body.sov, undefined, 'nor the share-of-voice series');
  assert.strictEqual(body.totals, undefined, 'nor the totals');

  /* ── 4. deep-link integrity survives the move ──────────────────────────── */
  // A narrative's ids ARE the board view: tapping the row fetches exactly them.
  // A cap that silently shortens the list shows fewer cards than the row
  // promised — which happened once, and dropped the cluster's only negative.
  for (const n of body.narratives) {
    assert.ok(Array.isArray(n.ids) && n.ids.length >= 2, `${n.name} carries its ids`);
    assert.ok(n.ids.length <= NARR_IDS_MAX, `${n.name} respects the ${NARR_IDS_MAX} cap`);
    assert.strictEqual(typeof n.idsTotal, 'number', `${n.name} carries the TRUE count, so the board can say "top N of M"`);
    assert.ok(n.idsTotal >= n.ids.length, `${n.name}: idsTotal is never smaller than the ids shipped`);
    assert.ok(n.ids.every((x) => ITEMS.some((i) => i.id === x)), `${n.name}: every id is real`);
    // The row also needs its series, sentiment split and rising flag.
    for (const k of ['total', 'negative', 'neutral', 'positive', 'series', 'brand']) {
      assert.ok(n[k] !== undefined, `${n.name} carries ${k}`);
    }
  }
  const all = body.narratives.flatMap((n) => n.ids);
  assert.strictEqual(new Set(all).size, all.length, 'no story appears in two narratives');
}

/* ── 5. the browser: first paint, then upgrade — and a failure changes nothing ── */
{
  let statsHits = 0, narrHits = 0, narrMode = 'ok';
  const core = await call({ days: '30' });
  _resetNarrativeCache();
  const upgraded = await call({ days: '30', view: 'narratives' });

  // A DIFFERENT window, with nothing left to refine — the shape that exposed
  // the stale-answer bug in 5e.
  const week = { ...core.body, meta: { ...core.body.meta, days: 7 }, narrativesPending: false,
    narratives: [{ name: 'Week-only cluster', brand: 'Vodafone', total: 3, negative: 3, neutral: 0, positive: 0,
      rising: false, ids: [1, 2, 3], idsTotal: 3, series: core.body.narratives[0].series }] };

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/api/auth') {
      if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
      return j({ email: 'a@b.com', role: 'viewer', kind: 'user' });
    }
    if (u.pathname === '/api/stats') {
      if (u.searchParams.get('view') === 'narratives') {
        narrHits++;
        if (narrMode === 'fail') { res.writeHead(500); return res.end('{}'); }
        // The model looked at the clusters and judged that none of them is one
        // real story. An empty array is an ANSWER, not a failure.
        if (narrMode === 'empty') return setTimeout(() => j({ narratives: [] }), 200);
        // Slow enough that the reader can change the window while it is in
        // flight — which is exactly how a stale answer reaches the page.
        if (narrMode === 'slow') return setTimeout(() => j(upgraded.body), 900);
        // Slow enough that the first paint provably happened without it.
        return setTimeout(() => j(upgraded.body), 400);
      }
      statsHits++;
      if (u.searchParams.get('days') === '7') return j(week);
      return j(core.body);
    }
    const f = u.pathname === '/stats' ? '/stats.html' : u.pathname;
    try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); }
    catch { res.writeHead(404); res.end('nf'); }
  });
  await new Promise((r) => server.listen(8941, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // 5a. First paint has the clustering, WITHOUT the upgrade having landed.
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8941/stats', { waitUntil: 'domcontentloaded' });
    // The narrative rows exist before the second request can possibly answer.
    await page.waitForSelector('#c-narr .lrow', { timeout: 5000 });
    const early = await page.$$eval('#c-narr .lrow .nm', (els) => els.map((e) => e.textContent));
    assert.ok(early.length > 0, 'the narrative card has rows on first paint, before the LLM answers');
    // And the rest of the page is already drawn.
    assert.ok(await page.$('#c-out .lrow'), 'the outlet leaderboard is drawn too');
    assert.match(await page.textContent('#c-narr .cs'), /refining/,
      'the card says its grouping is still being refined, rather than looking finished or broken');

    // 5b. The upgrade lands and replaces the rows with the model's titles.
    await page.waitForFunction(
      () => /Vodafone Cash outages/.test(document.querySelector('#c-narr')?.textContent || ''),
      null, { timeout: 6000 });
    const later = await page.$$eval('#c-narr .lrow .nm', (els) => els.map((e) => e.textContent));
    assert.notDeepStrictEqual(later, early, 'the rows were upgraded, not just re-rendered identically');
    assert.ok(!/refining/.test(await page.textContent('#c-narr .cs')), 'and the note clears when it lands');

    // The deep link still points at the ids the row promises.
    const href = await page.getAttribute('#c-narr .lrow', 'href');
    assert.match(href, /^\/\?ids=\d+(,\d+)+/, 'the row deep-links to its exact ids');
    assert.match(href, /&n=\d+/, 'and carries the TRUE count so the board can say "top N of M"');
    assert.deepStrictEqual(errs, [], 'no page errors');
    await page.close();
  }

  // 5c. A FAILED upgrade must leave the page exactly as it was. There is no
  //     failure state to render — nothing is missing, only un-upgraded.
  {
    narrMode = 'fail';
    const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8941/stats', { waitUntil: 'networkidle' });
    await page.waitForSelector('#c-narr .lrow', { timeout: 5000 });
    await page.waitForTimeout(400);
    const rows = await page.$$eval('#c-narr .lrow .nm', (els) => els.map((e) => e.textContent));
    assert.ok(rows.length > 0, 'the clustering is still on screen after the upgrade failed');
    const cs = await page.textContent('#c-narr .cs');
    assert.ok(!/refining|error|failed/i.test(cs), `and the card shows no error state (got "${cs}")`);
    assert.deepStrictEqual(errs, [], 'and no page error is thrown');
    await page.close();
  }

  // 5d. An EMPTY refinement is a RESULT, not a failure. Stage 1 errs toward
  //     splitting and toward grouping on shared vocabulary, so "none of these
  //     is really one story" is a verdict the model is entitled to reach — and
  //     keeping the clustering then leaves on screen exactly the false grouping
  //     the second pass exists to reject. It must clear to the card's own empty
  //     state, which reads as "no narratives yet", not as an error.
  {
    narrMode = 'empty';
    const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8941/stats', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#c-narr .lrow', { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('#c-narr .lrow'), null, { timeout: 6000 });
    assert.ok(await page.$('#c-narr .cbody .empty'),
      'an empty refinement replaces the rows with the card\'s own empty state');
    assert.match(await page.textContent('#c-narr .cbody'), /No multi-story narratives/i,
      'which says there are none, rather than showing a grouping the model rejected');
    const cs = await page.textContent('#c-narr .cs');
    assert.ok(!/refining|error|failed/i.test(cs), `and the refining note clears (got "${cs}")`);
    assert.deepStrictEqual(errs, [], 'no page errors');
    await page.close();
  }

  // 5e. A stale answer must NEVER paint over a newer window — including when
  //     the new window has nothing to refine. The sequence number used to be
  //     bumped only where a replacement request was about to be sent, so
  //     switching to a window with narrativesPending:false left it untouched:
  //     the 30-day answer still in flight then matched, passed the guard, and
  //     painted 30-day narratives onto a 7-day board. The guard has to move
  //     with the DATA, not with the request.
  {
    narrMode = 'slow';
    const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 't', refresh_token: 'r' })));
    await page.goto('http://localhost:8941/stats', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#c-narr .lrow', { timeout: 5000 });
    const before = narrHits;
    // Switch windows while the 30-day refinement is still in flight.
    await page.click('#winRow .chip[data-v="7"]');
    await page.waitForFunction(() => /Week-only cluster/.test(document.querySelector('#c-narr')?.textContent || ''),
      null, { timeout: 5000 });
    assert.strictEqual(narrHits, before, 'the new window asks for no refinement — there is nothing pending');
    // Outlast the in-flight 30-day answer.
    await page.waitForTimeout(1200);
    const txt = await page.textContent('#c-narr');
    assert.ok(!/Vodafone Cash outages/.test(txt),
      'the stale 30-day refinement never lands on the 7-day board');
    assert.match(txt, /Week-only cluster/, 'and the window the reader chose is still what they see');
    assert.deepStrictEqual(errs, [], 'no page errors');
    await page.close();
    narrMode = 'ok';
  }

  assert.ok(statsHits >= 2 && narrHits >= 2, 'both requests fired on both loads');
  await browser.close();
  server.close();
}

console.log('NARRATIVES-ASYNC OK — /api/stats makes zero Anthropic calls with the key CONFIGURED, ships the deterministic clustering so the card is populated on first paint, and ?view=narratives upgrades it afterwards; ids/idsTotal/the cap survive the split; a failed upgrade leaves the page unchanged with no error state, an EMPTY one clears to the card\'s empty state, and a stale answer never paints over a newer window');
