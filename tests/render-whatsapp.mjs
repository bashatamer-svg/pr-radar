// WhatsApp Cloud API urgent alerts: sends a TEMPLATE message to each configured
// recipient, no-ops when unconfigured, fail-soft on API errors. Mocks graph.facebook.com.
import assert from 'node:assert';

// unconfigured to start
delete process.env.WHATSAPP_ENABLED;

let calls = [];
let apiOk = true;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('graph.facebook.com')) {
    calls.push({ url: u, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return apiOk
      ? { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }), text: async () => '{}' }
      : { ok: false, status: 400, json: async () => ({}), text: async () => '{"error":{"message":"bad"}}' };
  }
  throw new Error('unexpected fetch ' + u);
};

const wa = await import(new URL('..', import.meta.url).pathname + '/lib/whatsapp.js');
const item = { brand: 'Vodafone', sentiment: 'negative', importance: 5,
  headline: 'Vodafone Cash outage spreads\nnationwide', pr_angle: 'Read · x\nAudience · y\nAction · Prepare a holding line' };

// ── unconfigured → no-op, no calls ──
calls = [];
let r = await wa.sendWhatsAppUrgent(item);
assert.strictEqual(r.sent, 0, 'unconfigured: nothing sent');
assert.ok(r.skipped, 'unconfigured: reported as skipped');
assert.strictEqual(calls.length, 0, 'unconfigured: no API calls');
assert.strictEqual(wa.whatsappConfigured(), false, 'not configured');

// ── alert line is a single line (Meta rejects newlines in template variables) ──
const line = wa.whatsappAlertLine(item);
const actionLine = wa.whatsappActionLine(item);
assert.ok(!/[\n\t]/.test(line) && !/[\n\t]/.test(actionLine), 'neither paragraph has newlines/tabs');
assert.ok(/Vodafone · negative — Vodafone Cash outage spreads nationwide/.test(line), 'brand · sentiment — headline');
// The tier LEADS, from the same urgentTier() that titles the email — a story
// must not arrive URGENT in one channel and ALERT in the other. The template's
// header is static text, so it can only live in the variable.
assert.ok(/^URGENT · /.test(line), `an Impact-5 story leads with URGENT (got "${line}")`);
{
  const soft = wa.whatsappAlertLine({ brand: 'Vodafone', sentiment: 'negative', importance: 2, headline: 'Minor billing gripe' });
  assert.ok(/^ALERT · /.test(soft), `a low-Impact Vodafone negative leads with ALERT (got "${soft}")`);
}
// The action is its OWN paragraph now, not a suffix on the story line — a
// variable value cannot contain a newline, so two paragraphs need two variables.
assert.ok(!/Action:/.test(line), 'the story line no longer carries the action');
assert.ok(/^Action: Prepare a holding line/.test(actionLine), 'the action is the second paragraph');
// Meta requires every declared variable to be filled, so paragraph 2 always has
// content — but it must never invent an action that the classifier did not give.
{
  const noAction = wa.whatsappActionLine({ headline: 'x', summary: 'Summary sentence.' });
  assert.strictEqual(noAction, 'Summary sentence.', 'falls back to the summary, not an invented action');
  const bare = wa.whatsappActionLine({ headline: 'x' });
  assert.ok(/open the board/i.test(bare) && !/^Action:/.test(bare), 'and to a plain pointer when there is nothing at all');
}

// ── configured → one template message per recipient, correct shape ──
process.env.WHATSAPP_ENABLED = '1';
process.env.WHATSAPP_TOKEN = 'tok123';
process.env.WHATSAPP_PHONE_ID = '99887766';
process.env.WHATSAPP_TO = '201000000001, +2010-0000-0002 , bad';   // 2 valid, 1 junk
process.env.WHATSAPP_TEMPLATE = 'pr_urgent';
process.env.WHATSAPP_TEMPLATE_LANG = 'ar';
assert.strictEqual(wa.whatsappRecipients().length, 2, 'parses 2 valid E.164 numbers, drops junk');
assert.strictEqual(wa.whatsappConfigured(), true, 'now configured');

calls = []; apiOk = true;
r = await wa.sendWhatsAppUrgent(item);
assert.strictEqual(r.sent, 2, 'sent to both recipients');
assert.strictEqual(r.failed, 0, 'none failed');
assert.strictEqual(calls.length, 2, 'one API call per recipient');
const c = calls[0];
assert.ok(c.url.includes('/99887766/messages'), 'posts to the phone-id messages endpoint');
assert.strictEqual(c.auth, 'Bearer tok123', 'bearer token attached');
assert.strictEqual(c.body.messaging_product, 'whatsapp', 'messaging_product set');
assert.strictEqual(c.body.type, 'template', 'sends a template (proactive-safe)');
assert.strictEqual(c.body.template.name, 'pr_urgent', 'template name from env');
assert.strictEqual(c.body.template.language.code, 'ar', 'template language from env');
const params = c.body.template.components[0].parameters;
assert.strictEqual(params.length, 2, 'two variables — the story and the action are separate paragraphs');
assert.strictEqual(params[0].text, line, 'first variable = what happened');
assert.strictEqual(params[1].text, actionLine, 'second variable = what to do about it');
const param = params[0];
// The parameter's SHAPE has to match how the approved template declares its
// variable, and a mismatch fails as #132001 — indistinguishable from a template
// that does not exist. The live template uses positional {{1}}, so the default
// must send NO parameter_name; adding one would break a working channel.
assert.ok(!('parameter_name' in param),
  `positional by default, matching the live {{1}} template (got ${JSON.stringify(param)})`);

// If Meta ever forces a NAMED variable, the same code sends the other shape —
// the env var holds the name exactly as written in the approved body.
{
  process.env.WHATSAPP_TEMPLATE_VAR = 'story,action';
  calls = [];
  await wa.sendWhatsAppUrgent(item);
  const named = calls[0].body.template.components[0].parameters;
  assert.strictEqual(named[0].parameter_name, 'story', 'names in the env send the named form, in order');
  assert.strictEqual(named[1].parameter_name, 'action', 'including the second variable');
  assert.strictEqual(named[0].text, line, 'still carries the story line');
  delete process.env.WHATSAPP_TEMPLATE_VAR;
}

// …and an explicit number is still positional, so setting it defensively is safe.
{
  process.env.WHATSAPP_TEMPLATE_VAR = '1,2';
  calls = [];
  await wa.sendWhatsAppUrgent(item);
  assert.ok(calls[0].body.template.components[0].parameters.every((p) => !('parameter_name' in p)),
    'explicit numeric var names are positional too');
  delete process.env.WHATSAPP_TEMPLATE_VAR;
}
assert.deepStrictEqual(wa.whatsappRecipients().sort(), ['201000000001', '201000000002'].sort(), 'digits-only recipients');

// ── API error → fail-soft (counted, never throws) ──
calls = []; apiOk = false;
r = await wa.sendWhatsAppUrgent(item);
assert.strictEqual(r.sent, 0, 'API error: none counted as sent');
assert.strictEqual(r.failed, 2, 'API error: both counted as failed');

// ── recipients come from Admin → Subscribers when WHATSAPP_TO is unset ──
// The env var needs a Vercel edit AND a redeploy, so in practice the list never
// changed: on 3 Aug it held ONE number while the daily brief reached five
// people — the channel added for speed reached the fewest readers.
{
  delete process.env.WHATSAPP_TO;
  const realFetch = globalThis.fetch;
  let askedForSubs = false;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/pr_subscribers')) {
      askedForSubs = true;
      // `active=is.true` and `whatsapp=not.is.null` must both be in the query —
      // a paused person must not be paged, and a row without a number must not
      // become an empty recipient.
      assert.ok(/active=is\.true/.test(u), `only active subscribers are paged (${u})`);
      assert.ok(/whatsapp=not\.is\.null/.test(u), `rows without a number are excluded (${u})`);
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { whatsapp: '201000000003' }, { whatsapp: '+20 100 000 0004' },
      ]) };
    }
    return realFetch(url, opts);
  };
  calls = []; apiOk = true;
  const sub = await wa.sendWhatsAppUrgent(item);
  assert.ok(askedForSubs, 'with no WHATSAPP_TO it reads the subscriber list');
  assert.strictEqual(sub.sent, 2, 'both subscribers with a number were messaged');
  assert.deepStrictEqual(calls.map((c) => c.body.to).sort(), ['201000000003', '201000000004'],
    'and a pasted "+20 100 …" is normalised to digits');

  // A DB failure must not silence the channel without saying so.
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/rest/v1/pr_subscribers')) throw new Error('db down');
    return realFetch(url, opts);
  };
  calls = [];
  const none = await wa.sendWhatsAppUrgent(item);
  assert.strictEqual(none.sent, 0, 'nothing is sent when the list cannot be read');
  assert.strictEqual(none.skipped, 'no recipients', 'and it is reported as skipped, not as a clean send');
  assert.strictEqual(calls.length, 0, 'no API call is made');

  globalThis.fetch = realFetch;
  process.env.WHATSAPP_TO = '201000000001, +2010-0000-0002 , bad';
}

// ── BOTH lists are messaged, deduped ──
// WHATSAPP_TO used to OVERRIDE the subscriber list: numbers typed into Admin
// were silently ignored while the panel still read "1 recipient", so you could
// add four people and page none of them.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/rest/v1/pr_subscribers')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { whatsapp: '201000000009' },
        { whatsapp: '201000000001' },   // ALSO in WHATSAPP_TO — must not double-send
      ]) };
    }
    return realFetch(url, opts);
  };
  calls = []; apiOk = true;
  const both = await wa.sendWhatsAppUrgent(item);
  const to = calls.map((c) => c.body.to).sort();
  assert.deepStrictEqual(to, ['201000000001', '201000000002', '201000000009'],
    `env and subscriber numbers are combined (got ${JSON.stringify(to)})`);
  assert.strictEqual(both.sent, 3, 'three distinct people messaged');
  assert.strictEqual(new Set(to).size, to.length, 'a number in both lists is messaged once, not twice');
  globalThis.fetch = realFetch;
}

// ── status shape for the admin UI ──
const st = wa.whatsappStatus();
assert.deepStrictEqual([st.enabled, st.hasToken, st.hasPhoneId, st.recipients, st.template], [true, true, true, 2, 'pr_urgent'], 'status reflects env');

console.log('WHATSAPP OK — no-op unconfigured; single-line template var; one template/recipient with correct shape; fail-soft on API error; status shape');
