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
assert.strictEqual(c.body.template.components[0].parameters[0].text, line, '{{1}} body variable = the alert line');
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
