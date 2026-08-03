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
assert.ok(!/[\n\t]/.test(line), 'alert line has no newlines/tabs');
assert.ok(/Vodafone · negative — Vodafone Cash outage spreads nationwide/.test(line), 'brand · sentiment — headline');
assert.ok(/Action: Prepare a holding line/.test(line), 'pulls the pr_angle Action clause');

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
const param = c.body.template.components[0].parameters[0];
assert.strictEqual(param.text, line, 'the body variable carries the alert line');
// Meta's editor REJECTS positional {{1}}; variables must be NAMED, and a named
// template must be SENT with parameter_name or the call fails in a way that
// looks exactly like a missing template (#132001).
assert.strictEqual(param.parameter_name, 'alert', 'named parameter by default, matching a {{alert}} template');

// An older positional {{1}} template still works — a numeric var name means
// "send it the old way", so an existing approved template is not orphaned.
{
  process.env.WHATSAPP_TEMPLATE_VAR = '1';
  calls = [];
  await wa.sendWhatsAppUrgent(item);
  const p1 = calls[0].body.template.components[0].parameters[0];
  assert.ok(!('parameter_name' in p1), 'a numeric var name sends the positional form');
  assert.strictEqual(p1.text, line, 'still carries the alert line');
  delete process.env.WHATSAPP_TEMPLATE_VAR;
}

// The name is taken verbatim from the env, so it can match whatever Meta approved.
{
  process.env.WHATSAPP_TEMPLATE_VAR = 'alert_line';
  calls = [];
  await wa.sendWhatsAppUrgent(item);
  assert.strictEqual(calls[0].body.template.components[0].parameters[0].parameter_name, 'alert_line',
    'the variable name comes from WHATSAPP_TEMPLATE_VAR');
  delete process.env.WHATSAPP_TEMPLATE_VAR;
}
assert.deepStrictEqual(wa.whatsappRecipients().sort(), ['201000000001', '201000000002'].sort(), 'digits-only recipients');

// ── API error → fail-soft (counted, never throws) ──
calls = []; apiOk = false;
r = await wa.sendWhatsAppUrgent(item);
assert.strictEqual(r.sent, 0, 'API error: none counted as sent');
assert.strictEqual(r.failed, 2, 'API error: both counted as failed');

// ── status shape for the admin UI ──
const st = wa.whatsappStatus();
assert.deepStrictEqual([st.enabled, st.hasToken, st.hasPhoneId, st.recipients, st.template], [true, true, true, 2, 'pr_urgent'], 'status reflects env');

console.log('WHATSAPP OK — no-op unconfigured; single-line template var; one template/recipient with correct shape; fail-soft on API error; status shape');
