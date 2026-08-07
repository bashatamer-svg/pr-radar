// Two checks about things that decay quietly.
//
// WHATSAPP. `whatsappConfigured()` answers "are the credentials present", which
// is one rung of five, and Admin read it as the whole question. Live on 4 Aug
// that gave the worst possible reading: template APPROVED, display name
// cleared, credentials set — and every send still failing, because the SENDER is
// a Meta-provisioned +1 555 test number that only reaches recipients
// pre-registered against it. A boolean cannot express "four things right, one
// wrong, and the wrong one is fatal".
//
// HOUSE KNOWLEDGE. The living-knowledge doc is injected into EVERY
// classification and marked AUTHORITATIVE, which is exactly why it decays
// badly: a line naming a live story is correct for a fortnight and then quietly
// starts steering unrelated news. Nothing ever prompted anyone to prune it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const { whatsappReadiness, whatsappCheck, isTestSender } = await import('../lib/whatsapp.js');
const { houseContextCheck, staleContextEntries, CONTEXT_STALE_DAYS, CONTEXT_REVIEW_DAYS, CONTEXT_UNAVAILABLE } =
  await import('../lib/house-context.js');

const wa = (env = {}, probe = {}) => {
  for (const k of ['WHATSAPP_ENABLED', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TO']) delete process.env[k];
  Object.assign(process.env, env);
  return whatsappReadiness(probe);
};
const rungOf = (r, id) => r.rungs.find((x) => x.id === id);

/* ═══ WhatsApp ═════════════════════════════════════════════════════════════ */

// The +1 555 test sender. It is the actual live blocker, and the one thing that
// looks identical to a delivery bug unless something names it.
{
  assert.strictEqual(isTestSender('+1 555-428-5748'), true, 'the Meta test range is recognised');
  assert.strictEqual(isTestSender('15554285748'), true, 'however it is formatted');
  assert.strictEqual(isTestSender('+20 100 123 4567'), false, 'an Egyptian business number is not');
  assert.strictEqual(isTestSender('+1 415 555 0100'), false,
    'and neither is a real US number that merely CONTAINS 555 — the test range is the prefix');
  assert.strictEqual(isTestSender(''), false, 'nothing is not a test number');
}

// Everything green except the sender. This is production's exact state, and the
// check must NOT read as ready.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '201001234567' },
    { displayNumber: '+1 555-428-5748', nameStatus: 'AVAILABLE_WITHOUT_REVIEW', templateStatus: 'APPROVED' });
  assert.notStrictEqual(r.state, 'ok',
    'credentials + approved template + cleared display name is NOT ready while the sender is a test number');
  assert.strictEqual(rungOf(r, 'credentials').state, 'ok');
  assert.strictEqual(rungOf(r, 'template').state, 'ok');
  assert.strictEqual(rungOf(r, 'name').state, 'ok', 'AVAILABLE_WITHOUT_REVIEW passes — the business is exempt from review');
  assert.strictEqual(rungOf(r, 'recipients').state, 'ok');
  assert.strictEqual(rungOf(r, 'sender').state, 'missing', 'and the sender is the one that fails');
  assert.match(r.detail, /sender/i, 'the summary names it');
  assert.match(r.hint, /#131037/, 'and gives the error code an operator will actually see');
}

// A real number with everything else green IS ready.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '201001234567' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED' });
  assert.strictEqual(r.state, 'ok', 'every rung confirmed reads ready');
  assert.match(r.detail, /every rung confirmed/);
}

// UNVERIFIED is not the same as FAILING. Template and display name can only be
// answered by asking Meta, so without a probe they are unknown — and the check
// must not claim ready on the strength of the rungs it can see locally.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '201001234567' });
  assert.strictEqual(r.state, 'unknown', 'no probe ⇒ unknown, never ok');
  assert.strictEqual(rungOf(r, 'template').state, 'unknown');
  assert.strictEqual(rungOf(r, 'name').state, 'unknown');
  assert.strictEqual(rungOf(r, 'sender').state, 'unknown');
  assert.match(r.detail, /unverified/, 'and says which rungs are unverified rather than assuming them');
  assert.match(r.hint, /Check account & template/, 'pointing at the tool that answers them');
}

// Nobody to page. Credentials perfect, channel useless — the failure that used
// to look identical to a clean send. Note the count is RESOLVED and passed in:
// "nobody" is a claim about env ∪ subscribers, and only the caller can make it.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED', recipients: 0 });
  assert.strictEqual(rungOf(r, 'recipients').state, 'missing', 'no recipients is a failed rung');
  assert.notStrictEqual(r.state, 'ok', 'and the channel is not ready without anyone to reach');
  assert.match(r.hint, /Admin → Subscribers/, 'naming where the list lives — not an env var');
}

// THE DOCUMENTED NORMAL SETUP: the crisis list lives in Admin → Subscribers and
// WHATSAPP_TO is empty, because the env var needs a Vercel edit AND a redeploy.
// Counting only the env var reported "nobody to page" — and warned the whole
// channel — for a setup that would have paged five people.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED', recipients: 5 });
  assert.strictEqual(rungOf(r, 'recipients').state, 'ok',
    'five subscriber numbers and an empty WHATSAPP_TO is a reachable channel');
  assert.match(rungOf(r, 'recipients').note, /5 number/, 'and the count is the resolved one');
  assert.strictEqual(r.state, 'ok', 'so the ladder reads ready');
}

// Not asked ≠ nobody. With no resolved count the function cannot see the
// subscriber list at all, so an empty env list is UNKNOWN — never a claim that
// there is nobody there.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED' });
  assert.strictEqual(rungOf(r, 'recipients').state, 'unknown',
    'without the resolved count, an empty WHATSAPP_TO proves nothing about the subscriber list');
  assert.notStrictEqual(r.state, 'ok', 'and an unverified rung still keeps the ladder off "ready"');
  // …but a populated env list is a FLOOR: those numbers are reachable whatever
  // the database says, so it is ok rather than unknown.
  const r2 = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '201001234567' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED' });
  assert.strictEqual(rungOf(r2, 'recipients').state, 'ok',
    'a number in WHATSAPP_TO is reachable regardless of the subscriber list');
}

// The resolver behind that count: the UNION, and it THROWS rather than
// under-reporting. `resolveWhatsappRecipients()` degrades to the env list so a
// crisis still reaches someone; a CHECK must not make that trade, or it reports
// a partial list as the whole one.
{
  const { whatsappRecipientCount } = await import('../lib/whatsapp.js');
  process.env.WHATSAPP_TO = '201001234567, 201009999999';
  globalThis.fetch = async (url) => {
    if (String(url).includes('pr_subscribers')) {
      return { ok: true, status: 200,
        text: async () => JSON.stringify([{ whatsapp: '201001234567' }, { whatsapp: '201005555555' }]) };
    }
    throw new Error('not asked');
  };
  assert.strictEqual(await whatsappRecipientCount(), 3,
    'env ∪ subscribers, deduped — the number in both places counts once');

  globalThis.fetch = async () => { throw new Error('database down'); };
  await assert.rejects(() => whatsappRecipientCount(),
    'an unreadable subscriber list throws, so the caller reports unknown instead of the env-only count');
  delete process.env.WHATSAPP_TO;
}

// A rejected template says templates do not transfer between accounts, which is
// the cause that cost the most time.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', WHATSAPP_TO: '201001234567' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'PENDING' });
  assert.strictEqual(rungOf(r, 'template').state, 'missing');
  assert.match(rungOf(r, 'template').note, /do NOT transfer between accounts/);
}

// OFF is off, not broken. A red page over a deliberately-disabled side channel
// trains its reader to ignore red.
{
  for (const k of ['WHATSAPP_ENABLED', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TO']) delete process.env[k];
  const c = whatsappCheck();
  assert.strictEqual(c.state, 'unknown', 'a disabled channel is unknown, not warn');
  assert.match(c.detail, /off/i);
  assert.match(c.hint, /Email carries every alert/, 'and says the alerts still land — which is the reassurance that matters');
}
// Never CRIT, whatever is wrong: WhatsApp is the side channel and email is the
// one that must work.
{
  const c = whatsappCheck.call(null);
  assert.notStrictEqual(c.state, 'crit');
  const bad = whatsappCheck({ displayNumber: '+15554285748', nameStatus: 'PENDING', templateStatus: 'REJECTED' });
  assert.notStrictEqual(bad.state, 'crit', 'even everything failing is not critical for a secondary channel');
}

/* ═══ The alert channel — can this page reach you at all? ══════════════════ */
//
// Every other check on Health reports on the pipeline. This one reports on the
// thing that DELIVERS those reports, and nothing did: the `recipients` check
// counts the daily BRIEF's audience, which is a different list for a different
// purpose. The failure is silent by construction — sendOpsAlert calls
// recordAlert() BEFORE it attempts delivery, so with no recipients every
// warning was still written to pr_alerts and still shown in the 14-day history
// while reaching no inbox. It never looked broken; it looked quiet.
{
  const { opsChannelCheck, opsAlertRecipients } = await import('../lib/email.js');
  const ops = (env = {}) => {
    for (const k of ['OPS_ALERT_TO', 'RADAR_TO', 'RADAR_FROM', 'RESEND_API_KEY']) delete process.env[k];
    Object.assign(process.env, env);
    return opsChannelCheck();
  };

  // THE BUG, as it stood in production until 7 Aug: credentials fine, nobody
  // to send to, and nothing anywhere saying so.
  {
    const c = ops({ RADAR_FROM: 'a@b.com', RESEND_API_KEY: 'k' });
    assert.strictEqual(c.state, 'crit',
      'a health push that reaches nobody is critical — every other check on the page is then page-only');
    assert.match(c.detail, /reaches nobody/, 'and says so plainly');
    assert.match(c.detail, /OPS_ALERT_TO/, 'naming the variable that fixes it');
    assert.match(c.hint, /redeploy/i, 'and that an env var needs a redeploy, not just a save');
    // The trap this check exists to close: resets DO still arrive, via
    // ADMIN_EMAILS on the one caller that passes opts.to — so "my reset email
    // came through" is not evidence the alert channel works.
    assert.match(c.hint, /reset arriving is NOT evidence/i,
      'and warns that a working password-reset email does not prove this channel works');
  }

  // Configured — the state production reached on 7 Aug.
  {
    const c = ops({ OPS_ALERT_TO: 'ops@x.com', RADAR_FROM: 'a@b.com', RESEND_API_KEY: 'k' });
    assert.strictEqual(c.state, 'ok', 'one operator address is a working channel');
    assert.match(c.detail, /1 operator via OPS_ALERT_TO/, 'reporting the count and the source');
    // The COUNT, never the addresses — same call the WhatsApp check makes by
    // masking numbers. A health page answers "is it configured", not "who".
    assert.ok(!/ops@x\.com/.test(`${c.detail} ${c.hint}`),
      'and never prints the operator addresses themselves');
  }

  // Falling back to the brief list works, but is worth saying out loud: those
  // are the people who read the news, not the person who runs the radar.
  {
    const c = ops({ RADAR_TO: 'a@x.com, b@x.com', RADAR_FROM: 'a@b.com', RESEND_API_KEY: 'k' });
    assert.strictEqual(c.state, 'ok');
    assert.match(c.detail, /2 operators via RADAR_TO/, 'the fallback is reported as the fallback');
    assert.match(c.hint, /read the news, not the person who runs the radar/, 'and why that is not ideal');
  }

  // No provider at all. The brief's `recipients` check counts addresses and
  // would say nothing about this — a list of recipients is not a channel.
  {
    const c = ops({ OPS_ALERT_TO: 'ops@x.com' });
    assert.strictEqual(c.state, 'crit', 'recipients with no provider is still a dead channel');
    assert.match(c.detail, /RESEND_API_KEY and RADAR_FROM/, 'naming both missing pieces');
  }
  {
    const c = ops({ OPS_ALERT_TO: 'ops@x.com', RESEND_API_KEY: 'k' });
    assert.match(c.detail, /RADAR_FROM/, 'or just the one that is missing');
    assert.ok(!/RESEND_API_KEY/.test(c.detail), 'and not the one that is present');
  }

  // THE ANTI-DRIFT PROPERTY, which is the whole reason this lives in
  // lib/email.js beside the sender: the check and sendOpsAlert read ONE
  // expression. Two copies of a fallback chain is how a check comes to reassure
  // you about a channel the sender no longer uses.
  {
    const src = readFileSync(new URL('../lib/email.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function sendOpsAlert'),
      src.indexOf('export function opsAlertRecipients'));
    assert.ok(/opsAlertRecipients\(\)/.test(fn),
      'sendOpsAlert resolves its recipients through the shared helper');
    assert.ok(!/process\.env\.OPS_ALERT_TO/.test(fn),
      'and does NOT re-read the env chain itself, or the check could drift from the sender');
    process.env.OPS_ALERT_TO = 'x@y.com';
    assert.deepStrictEqual(opsAlertRecipients().map((a) => String(a)), ['x@y.com'],
      'and the helper is what both of them call');
    delete process.env.OPS_ALERT_TO;
  }
}

/* ═══ House knowledge ══════════════════════════════════════════════════════ */

const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
const dateAgo = (d) => daysAgo(d).slice(0, 10);

// A dated line whose story has ended.
{
  const doc = [
    `[${dateAgo(90)}] The توليت song is the music in a Vodafone ad`,
    `[${dateAgo(3)}] The Inas Ezzeddin 5-lines case is against Vodafone`,
    'An undated standing fact about Vodafone Cash',
  ].join('\n');
  const stale = staleContextEntries(doc);
  assert.strictEqual(stale.length, 1, 'only the expired line is flagged');
  assert.match(stale[0].text, /توليت/, 'and it is the right one');
  assert.ok(stale[0].ageDays >= 89, 'with its age');

  const c = houseContextCheck({ content: doc, updatedAt: daysAgo(3) });
  assert.strictEqual(c.state, 'warn', 'a stale entry warns');
  assert.match(c.detail, /older than 45 days/, 'naming the bar');
  assert.match(c.detail, /توليت/, 'and quoting the entry, so it can be found and cut');
  assert.match(c.hint, /injected into EVERY classification/i,
    'and saying why it matters — a stale line keeps steering unrelated news');
  assert.notStrictEqual(c.state, 'crit', 'but it is a nudge to prune, not an outage');
}

// Undated lines are NOT flagged. Dating is a convention the doc adopts
// gradually; flagging every undated line would make the check permanently amber
// on the doc as it exists today, which is how a check stops being read.
{
  const doc = 'The توليت song is a Vodafone ad\nThe 5-lines case is against Vodafone';
  assert.deepStrictEqual(staleContextEntries(doc), [], 'an undated line has no age to judge');
  const fresh = houseContextCheck({ content: doc, updatedAt: daysAgo(5) });
  assert.strictEqual(fresh.state, 'ok', 'a recently-edited undated doc is fine');
  assert.match(fresh.detail, /2 line\(s\)/, 'and reports its size');
}

// …but a doc nobody has touched at all is worth raising, and the hint teaches
// the convention that would make the check precise.
{
  const c = houseContextCheck({ content: 'Some standing fact', updatedAt: daysAgo(CONTEXT_REVIEW_DAYS + 10) });
  assert.strictEqual(c.state, 'warn', 'an untouched doc warns');
  assert.match(c.detail, /untouched for \d+ days/);
  assert.match(c.hint, /\[YYYY-MM-DD\]/, 'and teaches the dating convention that would make this precise');
}

// Empty is a good state, not a missing one: the static HOUSE_CONTEXT still applies.
{
  const c = houseContextCheck({ content: '', updatedAt: null });
  assert.strictEqual(c.state, 'ok');
  assert.match(c.detail, /static house context/);
}
// Unreadable is unknown.
{
  assert.strictEqual(houseContextCheck({}).state, 'unknown');
  assert.strictEqual(houseContextCheck().state, 'unknown');
}
// …and "could not ask" must not be able to arrive looking like "nothing there".
// The two queries are independent, so a content read can fail while the
// timestamp read succeeds — and `.catch(() => '')` turned that into the healthy
// "empty — only the static house context is injected", hiding a database
// failure behind an ok on the one page whose job is to report it.
{
  const c = houseContextCheck({ content: CONTEXT_UNAVAILABLE, updatedAt: daysAgo(3) });
  assert.strictEqual(c.state, 'unknown',
    'a failed content read is unknown even when the timestamp read succeeded');
  assert.match(c.detail, /could not read/i, 'and says so');
  assert.notStrictEqual(houseContextCheck({ content: '', updatedAt: daysAgo(3) }).state, 'unknown',
    'while a genuinely empty document is still the good state it always was');
}
{
  assert.ok(CONTEXT_STALE_DAYS < CONTEXT_REVIEW_DAYS,
    'a single entry expires before the whole doc is called unreviewed — the specific signal must fire first');
}

/* ═══ both reach /api/alerts, and neither can break it ═════════════════════ */
{
  process.env.CRON_SECRET = 'cronsecret';
  process.env.WHATSAPP_ENABLED = '1';
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = 'p';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('pr_context')) {
      return { ok: true, status: 200,
        text: async () => JSON.stringify([{ content: `[${dateAgo(200)}] an ancient fact`, updated_at: daysAgo(200) }]) };
    }
    // The crisis list as it is actually kept: three numbers in Admin, nothing
    // in WHATSAPP_TO.
    if (u.includes('pr_subscribers') && u.includes('whatsapp=not.is.null')) {
      return { ok: true, status: 200,
        text: async () => JSON.stringify([{ whatsapp: '201001111111' }, { whatsapp: '201002222222' }, { whatsapp: '201003333333' }]) };
    }
    throw new Error('everything else is down');
  };
  const { default: alerts } = await import('../api/alerts.js');
  let out = null, code = 0;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { out = b; return res; }, setHeader() {}, end: () => res };
  await alerts({ method: 'GET', query: {}, headers: { authorization: 'Bearer cronsecret' } }, res);
  assert.strictEqual(code, 200, 'health answers with every other probe failing');
  const ids = out.checks.map((c) => c.id);
  assert.ok(ids.includes('whatsapp'), 'the WhatsApp readiness check is present');
  assert.ok(ids.includes('context'), 'and the house-knowledge check');
  const ctx = out.checks.find((c) => c.id === 'context');
  assert.strictEqual(ctx.state, 'warn', 'the 200-day-old entry is flagged');
  assert.match(ctx.detail, /ancient fact/, 'and quoted');

  // The endpoint RESOLVES the recipient list before it judges the rung — this
  // is the wiring, not just the pure function. WHATSAPP_TO is unset here, so
  // the env-only count would have reported "nobody to page" for three numbers
  // that would all have been messaged.
  const waCheck = out.checks.find((c) => c.id === 'whatsapp');
  assert.ok(!/nobody to page/.test(`${waCheck.detail} ${waCheck.hint}`),
    `subscriber numbers count as recipients (got "${waCheck.detail}")`);
  assert.ok(!/recipients/i.test(waCheck.detail),
    'so recipients is not among the blocked rungs');
}

console.log('READINESS OK — WhatsApp is a five-rung ladder, so an approved template with a +1 555 test sender never reads as ready and an unprobed rung reads as unverified rather than fine; recipients are counted from env ∪ subscribers (the list lives in Admin, so the env var alone said "nobody to page" for a working channel) and an unreadable list is unknown, not zero; the house-knowledge doc flags dated entries past 45 days and an untouched doc past 60, leaves undated lines alone, treats empty as good but a FAILED read as unknown, and neither check can be critical or break the page');
