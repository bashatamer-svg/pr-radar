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

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const { whatsappReadiness, whatsappCheck, isTestSender } = await import('../lib/whatsapp.js');
const { houseContextCheck, staleContextEntries, CONTEXT_STALE_DAYS, CONTEXT_REVIEW_DAYS } =
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
// to look identical to a clean send.
{
  const r = wa({ WHATSAPP_ENABLED: '1', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p' },
    { displayNumber: '+20 100 123 4567', nameStatus: 'APPROVED', templateStatus: 'APPROVED' });
  assert.strictEqual(rungOf(r, 'recipients').state, 'missing', 'no recipients is a failed rung');
  assert.notStrictEqual(r.state, 'ok', 'and the channel is not ready without anyone to reach');
  assert.match(r.hint, /Admin → Subscribers/, 'naming where the list lives — not an env var');
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
}

console.log('READINESS OK — WhatsApp is a five-rung ladder, so an approved template with a +1 555 test sender never reads as ready and an unprobed rung reads as unverified rather than fine; the house-knowledge doc flags dated entries past 45 days and an untouched doc past 60, leaves undated lines alone, treats empty as good, and neither check can be critical or break the page');
