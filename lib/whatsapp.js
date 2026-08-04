// WhatsApp Cloud API — proactive urgent alerts as 1:1 messages to opted-in team
// members. WhatsApp's official API can NOT post to a group, so this DMs each
// recipient. Business-initiated messages (outside the 24h service window) need a
// Meta-PRE-APPROVED template, so we send a template whose single body variable
// carries the one-line alert. Put the board link in the template itself
// (static text or a URL button) — template variables can't hold newlines/URLs.
//
// Meta setup (once):
//   1. WhatsApp Business account + a sender number → note its PHONE NUMBER ID.
//   2. A permanent (system-user) access token → WHATSAPP_TOKEN.
//   3. Create + get a Utility template approved, e.g. "pr_urgent" with body:
//        🚨 PR Radar — urgent
//        {{1}}
//
//        {{2}}
//        Open the board to respond: https://pr-radar.approvalavengers.com/
//      TWO variables, because a variable's VALUE cannot contain a newline —
//      the blank line between the story and the action lives in the template.
//      If Meta's editor makes you NAME them (e.g. {{story}}, {{action}}), put
//      those names, in order, in WHATSAPP_TEMPLATE_VAR — the shape must match.
//   4. Each recipient messages the number once to opt in. Add their number to
//      the person's row in Admin → Subscribers (or WHATSAPP_TO to override).
//
// Env: WHATSAPP_ENABLED=1, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TO (CSV),
//      WHATSAPP_TEMPLATE (default pr_urgent), WHATSAPP_TEMPLATE_LANG (default en),
//      WHATSAPP_TEMPLATE_VAR (default "1,2" = positional; names = named variables),
//      WHATSAPP_GRAPH_VERSION (default v21.0).
// Fail-soft: never throws; returns a { sent, failed, recipients } summary.

import { whatsappSubscribers } from './db.js';
import { urgentTier } from './email.js';

const digits = (s) => String(s || '').replace(/[^\d]/g, '');

/** The env-var list. Kept as a fallback and an override: it needs a Vercel edit
    plus a redeploy, so it is the wrong place to manage people day to day. */
export function whatsappRecipients() {
  return String(process.env.WHATSAPP_TO || '').split(',').map(digits).filter((s) => s.length >= 8);
}

/** Who actually gets paged: BOTH lists, deduped.
    WHATSAPP_TO used to override, which meant numbers typed into Admin were
    silently ignored while the page still said "1 recipient" — you could add
    four people and page none of them. Both are real recipients, so both are
    used; a number in both places is messaged once, not twice.
    Fail-soft: a DB error leaves the env list working rather than silencing the
    channel, and is logged rather than swallowed. */
export async function resolveWhatsappRecipients() {
  const env = whatsappRecipients();
  let subs = [];
  try { subs = await whatsappSubscribers(); }
  catch (e) { console.error('whatsapp: subscriber lookup failed', e.message); }
  return [...new Set([...env, ...subs])];
}

// Who will actually be messaged, in a form an admin can RECOGNISE without the
// page becoming a directory of personal mobile numbers. The count alone answers
// "is it configured" but not "is it the right people" — and this list is who
// gets woken at 3am, so it has to be checkable without opening Vercel.
export function whatsappRecipientsMasked() {
  return whatsappRecipients().map((n) => (n.length <= 6 ? n : `${n.slice(0, 2)}${'•'.repeat(Math.max(2, n.length - 6))}${n.slice(-4)}`));
}

export function whatsappStatus() {
  return {
    enabled: process.env.WHATSAPP_ENABLED === '1',
    hasToken: !!process.env.WHATSAPP_TOKEN,
    hasPhoneId: !!process.env.WHATSAPP_PHONE_ID,
    recipients: whatsappRecipients().length,
    template: process.env.WHATSAPP_TEMPLATE || 'pr_urgent',
    templateVar: process.env.WHATSAPP_TEMPLATE_VAR || '1,2',
  };
}

/** Credentials only. Recipients are resolved at send time (env OR subscribers),
    so requiring WHATSAPP_TO here would keep the channel "unconfigured" for a
    list managed entirely in Admin — which is now the normal case. */
export function whatsappConfigured() {
  const s = whatsappStatus();
  return s.enabled && s.hasToken && s.hasPhoneId;
}

// TWO paragraphs, so TWO variables. Meta rejects newlines inside a variable
// VALUE, so the only way to get a paragraph break is to declare two variables
// and put the blank line between them in the template body itself.
//   {{1}} — what happened   {{2}} — what to do about it
// Each is a SINGLE line, factual, bounded.
export function whatsappAlertLine(item) {
  // The tier leads, from the SAME urgentTier() that titles the email and badges
  // it — so a story cannot arrive as URGENT in one channel and ALERT in the
  // other. It has to live in the variable: the template's header line is static
  // text and cannot change per message without a new template and a new review.
  const bits = [urgentTier(item).label];
  if (item.brand) bits.push(item.brand);
  if (item.sentiment) bits.push(item.sentiment);
  const head = String(item.headline || '').trim();
  const line = head ? `${bits.join(' · ')} — ${head}` : bits.join(' · ');
  return oneLine(line) || 'New urgent item';
}

// The second paragraph. When the classifier gave no Action clause this says so
// plainly and points at the board — it must never invent one, and an empty
// string is not an option: Meta requires every declared variable to be filled.
export function whatsappActionLine(item) {
  const action = actionOf(item);
  if (action) return oneLine(`Action: ${action}`);
  const summary = oneLine(String(item.summary || ''));
  return summary || 'No action noted yet — open the board for the full brief.';
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 900);

function actionOf(item) {
  const m = String(item.pr_angle || '').match(/Action\s*[·:\-–]\s*([^\n]+)/i);
  const v = m && m[1].trim();
  return v && !/^[—–\-·.\s]*$/.test(v) ? v : '';
}

// The parameters' SHAPE must match how the approved template declares its
// variables, and a mismatch fails as #132001 — indistinguishable from a
// template that does not exist.
//   `{{1}} {{2}}`          → positional: no parameter_name  (the live template)
//   `{{story}} {{action}}` → named: parameter_name required
// WHATSAPP_TEMPLATE_VAR is a CSV of the variables exactly as written in the
// body, in order. Numeric entries (the default) send positional.
export function bodyParams(texts, varSpec = '1,2') {
  const names = String(varSpec || '').split(',').map((x) => x.trim());
  return texts.map((text, i) => {
    const name = names[i] || '';
    return (!name || /^\d+$/.test(name)) ? { type: 'text', text } : { type: 'text', parameter_name: name, text };
  });
}

async function sendOne(to, lines, cfg) {
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
        components: [{ type: 'body', parameters: bodyParams(lines, cfg.varName) }],
      },
    }),
  });
  if (r.ok) return { ok: true };
  // Meta's refusals are specific and actionable — "#131037 display name needs
  // approval", "#132001 template does not exist" — but they only ever reached
  // the function log, and the admin who pressed the button cannot read that.
  // "1 failed (check logs)" is a dead end for the one person trying to fix it,
  // so carry the reason back to the caller.
  const body = await r.text().catch(() => '');
  let err = null;
  try { err = JSON.parse(body).error; } catch { /* not JSON — fall back to the status */ }
  const reason = err?.message ? `${err.code ? `#${err.code} ` : ''}${err.message}` : `HTTP ${r.status}`;
  console.error('whatsapp send failed', to.slice(-4), r.status, body.slice(0, 200));
  return { ok: false, reason };
}

// Send one urgent item to every configured recipient. No-op (no error) when
// WhatsApp isn't configured. Never throws. Returns { sent, failed, recipients }.
/** @param opts.to  explicit recipient list, bypassing resolution. Used by the
 *  admin TEST so a delivery check goes to the configured test number(s) only
 *  and never pages the whole team — the same reason the email test sends only
 *  to the signed-in admin. */
export async function sendWhatsAppUrgent(item, opts = {}) {
  if (!whatsappConfigured()) return { sent: 0, failed: 0, recipients: 0, skipped: 'not configured' };
  const cfg = {
    token: process.env.WHATSAPP_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_ID,
    template: process.env.WHATSAPP_TEMPLATE || 'pr_urgent',
    lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
    varName: process.env.WHATSAPP_TEMPLATE_VAR || '1,2',
    version: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  };
  const lines = [whatsappAlertLine(item), whatsappActionLine(item)];
  const to = Array.isArray(opts.to) ? opts.to.map(digits).filter((n) => n.length >= 8) : await resolveWhatsappRecipients();
  // Credentials present but nobody to send to is a MISCONFIGURATION, not a
  // quiet success: it looks identical to "sent fine" in every log and counter.
  if (!to.length) {
    console.error('WHATSAPP ALERT NOT SENT — no recipients. Add a number to a subscriber in Admin → Subscribers, or set WHATSAPP_TO.');
    return { sent: 0, failed: 0, recipients: 0, skipped: 'no recipients' };
  }
  let sent = 0, failed = 0;
  const errors = [];
  await Promise.all(to.map(async (num) => {
    try {
      const r = await sendOne(num, lines, cfg);
      if (r.ok) sent++; else { failed++; errors.push(r.reason); }
    } catch (e) { failed++; errors.push(e.message); console.error('whatsapp send error', e.message); }
  }));
  // DISTINCT reasons: five recipients blocked by one account-level problem is
  // one fact, not five, and repeating it five times hides that it is one fix.
  return { sent, failed, recipients: to.length, ...(errors.length ? { errors: [...new Set(errors)] } : {}) };
}
