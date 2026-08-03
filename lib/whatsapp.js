// WhatsApp Cloud API — proactive urgent alerts as 1:1 messages to opted-in team
// members. WhatsApp's official API can NOT post to a group, so this DMs each
// recipient. Business-initiated messages (outside the 24h service window) need a
// Meta-PRE-APPROVED template, so we send a template whose single NAMED body
// variable carries the one-line alert. Put the board link in the template itself
// (static text or a URL button) — template variables can't hold newlines/URLs.
//
// Meta setup (once):
//   1. WhatsApp Business account + a sender number → note its PHONE NUMBER ID.
//   2. A permanent (system-user) access token → WHATSAPP_TOKEN.
//   3. Create + get a Utility template approved, e.g. "pr_urgent" with body:
//        🚨 PR Radar — urgent
//        {{alert}}
//        Open the board to respond: https://pr-radar.approvalavengers.com/
//      Meta's editor REJECTS positional `{{1}}` — variables must be named and
//      lowercase. Whatever you name it goes in WHATSAPP_TEMPLATE_VAR.
//   4. Each recipient messages the number once to opt in; list their numbers
//      (E.164, digits only, e.g. 2010…) in WHATSAPP_TO.
//
// Env: WHATSAPP_ENABLED=1, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TO (CSV),
//      WHATSAPP_TEMPLATE (default pr_urgent), WHATSAPP_TEMPLATE_LANG (default en),
//      WHATSAPP_TEMPLATE_VAR (default alert; a numeric value = old positional form),
//      WHATSAPP_GRAPH_VERSION (default v21.0).
// Fail-soft: never throws; returns a { sent, failed, recipients } summary.

const digits = (s) => String(s || '').replace(/[^\d]/g, '');

export function whatsappRecipients() {
  return String(process.env.WHATSAPP_TO || '').split(',').map(digits).filter((s) => s.length >= 8);
}

export function whatsappStatus() {
  return {
    enabled: process.env.WHATSAPP_ENABLED === '1',
    hasToken: !!process.env.WHATSAPP_TOKEN,
    hasPhoneId: !!process.env.WHATSAPP_PHONE_ID,
    recipients: whatsappRecipients().length,
    template: process.env.WHATSAPP_TEMPLATE || 'pr_urgent',
    templateVar: process.env.WHATSAPP_TEMPLATE_VAR || 'alert',
  };
}

export function whatsappConfigured() {
  const s = whatsappStatus();
  return s.enabled && s.hasToken && s.hasPhoneId && s.recipients > 0;
}

// The body variable's value — a SINGLE line (Meta rejects newlines/tabs in
// template variables), factual, bounded. Pulls the pr_angle "Action" clause when present.
export function whatsappAlertLine(item) {
  const bits = [];
  if (item.brand) bits.push(item.brand);
  if (item.sentiment) bits.push(item.sentiment);
  const head = String(item.headline || '').trim();
  let line = bits.length ? `${bits.join(' · ')} — ${head}` : head;
  const action = actionOf(item);
  if (action) line += ` · Action: ${action}`;
  return line.replace(/\s+/g, ' ').trim().slice(0, 900) || 'New urgent item';
}
function actionOf(item) {
  const m = String(item.pr_angle || '').match(/Action\s*[·:\-–]\s*([^\n]+)/i);
  const v = m && m[1].trim();
  return v && !/^[—–\-·.\s]*$/.test(v) ? v : '';
}

// Meta's template editor now REJECTS positional `{{1}}` variables: they must be
// named, lowercase, e.g. `{{alert}}`. A named template also has to be SENT with
// `parameter_name` on each parameter — send a positional parameter to a named
// template (or vice versa) and it fails, indistinguishably from a missing
// template. WHATSAPP_TEMPLATE_VAR is the variable's name exactly as it appears
// in the template body; a purely numeric value means the old positional form,
// so an existing `{{1}}` template still works by setting it to `1`.
export function bodyParam(text, varName = 'alert') {
  const name = String(varName || '').trim();
  if (!name || /^\d+$/.test(name)) return { type: 'text', text };
  return { type: 'text', parameter_name: name, text };
}

async function sendOne(to, line, cfg) {
  const url = `https://graph.facebook.com/${cfg.version}/${cfg.phoneId}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: cfg.template,
        language: { code: cfg.lang },
        components: [{ type: 'body', parameters: [bodyParam(line, cfg.varName)] }],
      },
    }),
  });
  if (r.ok) return true;
  console.error('whatsapp send failed', to.slice(-4), r.status, (await r.text().catch(() => '')).slice(0, 200));
  return false;
}

// Send one urgent item to every configured recipient. No-op (no error) when
// WhatsApp isn't configured. Never throws. Returns { sent, failed, recipients }.
export async function sendWhatsAppUrgent(item) {
  if (!whatsappConfigured()) return { sent: 0, failed: 0, recipients: 0, skipped: 'not configured' };
  const cfg = {
    token: process.env.WHATSAPP_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_ID,
    template: process.env.WHATSAPP_TEMPLATE || 'pr_urgent',
    lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
    varName: process.env.WHATSAPP_TEMPLATE_VAR || 'alert',
    version: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  };
  const line = whatsappAlertLine(item);
  const to = whatsappRecipients();
  let sent = 0, failed = 0;
  await Promise.all(to.map(async (num) => {
    try { (await sendOne(num, line, cfg)) ? sent++ : failed++; }
    catch (e) { failed++; console.error('whatsapp send error', e.message); }
  }));
  return { sent, failed, recipients: to.length };
}
