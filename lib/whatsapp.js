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

/** How many distinct numbers a send would actually reach — env ∪ subscribers.
    THROWS when the subscriber list cannot be read, unlike
    `resolveWhatsappRecipients()` which degrades to the env list so a crisis
    still reaches someone. A CHECK must not make that trade: reporting the
    env-only count as though it were the whole list is how Health came to say
    "nobody to page" about a list managed entirely in Admin. */
export async function whatsappRecipientCount() {
  const env = whatsappRecipients();
  const subs = await whatsappSubscribers();
  return new Set([...env, ...subs]).size;
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

/* ── READINESS, as a ladder rather than a boolean ──────────────────────────
   `whatsappConfigured()` answers "are the credentials present", which is rung
   one of five, and Admin read it as though it were the whole question. Live on
   4 Aug that produced the worst possible reading: template APPROVED, display
   name cleared, credentials set — and every send still failing, because the
   SENDER is a Meta-provisioned +1 555 test number that only reaches recipients
   pre-registered against it.

   So: never report the channel ready because one rung is green. The rungs, in
   the order a send actually needs them:
     1. credentials      WHATSAPP_ENABLED + token + phone id
     2. a real sender    NOT a +1 555 test number
     3. a template       approved on the WABA the phone id belongs to
     4. a display name   APPROVED or AVAILABLE_WITHOUT_REVIEW
     5. recipients       subscribers ∪ WHATSAPP_TO
   Rungs 3 and 4 can only be answered by asking Meta (Admin → Tools →
   "Check account & template"), so they are passed IN when known and reported as
   unknown when not — guessing them is how "approved" came to mean "working". */

// Meta hands out +1 555-01xx style numbers as test senders. They reach only
// pre-registered recipients, which is indistinguishable from a delivery bug
// unless something says so.
export function isTestSender(displayNumber) {
  const digits = String(displayNumber || '').replace(/[^\d]/g, '');
  return /^1555/.test(digits);
}

/** → { state, rungs[], detail, hint }. `probe` carries whatever Meta last told
    us (from the whatsapp-check tool): { displayNumber, nameStatus, templateStatus }. */
export function whatsappReadiness(probe = {}) {
  const s = whatsappStatus();
  const rung = (id, label, state, note) => ({ id, label, state, note });
  const rungs = [];

  rungs.push(s.enabled && s.hasToken && s.hasPhoneId
    ? rung('credentials', 'Credentials', 'ok', 'WHATSAPP_ENABLED, token and phone id are set')
    : rung('credentials', 'Credentials', 'missing',
        `missing: ${[!s.enabled && 'WHATSAPP_ENABLED=1', !s.hasToken && 'WHATSAPP_TOKEN', !s.hasPhoneId && 'WHATSAPP_PHONE_ID'].filter(Boolean).join(', ')}`));

  if (!probe.displayNumber) {
    rungs.push(rung('sender', 'Sender number', 'unknown', 'run Admin → Tools → "Check account & template" to read it from Meta'));
  } else if (isTestSender(probe.displayNumber)) {
    rungs.push(rung('sender', 'Sender number', 'missing',
      'a Meta-provisioned +1 555 TEST number — it only reaches recipients pre-registered against it, so real sends fail with #131037'));
  } else {
    rungs.push(rung('sender', 'Sender number', 'ok', 'a real business number'));
  }

  rungs.push(probe.templateStatus == null
    ? rung('template', `Template ${s.template}`, 'unknown', 'ask Meta with the account/template check')
    : /approved/i.test(probe.templateStatus)
      ? rung('template', `Template ${s.template}`, 'ok', 'approved on this account')
      : rung('template', `Template ${s.template}`, 'missing',
          `${probe.templateStatus} — templates do NOT transfer between accounts, so it must be approved on the WABA this phone id belongs to`));

  rungs.push(probe.nameStatus == null
    ? rung('name', 'Display name', 'unknown', 'ask Meta with the account/template check')
    : /^(APPROVED|AVAILABLE_WITHOUT_REVIEW)$/i.test(probe.nameStatus)
      // Two passing values, not one: AVAILABLE_WITHOUT_REVIEW means the
      // business is exempt. Treating everything ≠ APPROVED as a blocker told
      // the operator to wait on a review Meta had already cleared.
      ? rung('name', 'Display name', 'ok', probe.nameStatus)
      : rung('name', 'Display name', 'missing', `${probe.nameStatus} — sending is blocked until this clears`));

  // RESOLVED recipients — env ∪ subscribers — not the env list alone. The
  // crisis list lives in Admin → Subscribers precisely because WHATSAPP_TO
  // needs a Vercel edit and a redeploy, so in the documented normal setup the
  // env list is EMPTY and every real recipient is a database row. Counting only
  // the env var reported "nobody to page" for a channel that would have paged
  // five people, and warned the whole check on it.
  const reach = Number.isFinite(probe.recipients) ? probe.recipients : null;
  rungs.push(reach == null
    ? (s.recipients > 0
      // The env list alone already proves at least these numbers are reachable,
      // so this is not unknown — it is a floor.
      ? rung('recipients', 'Recipients', 'ok', `${s.recipients} number(s) in WHATSAPP_TO — the subscriber list was not read`)
      : rung('recipients', 'Recipients', 'unknown', 'the subscriber list was not read, and WHATSAPP_TO is empty'))
    : reach > 0
      ? rung('recipients', 'Recipients', 'ok', `${reach} number(s) — Admin → Subscribers, plus WHATSAPP_TO`)
      : rung('recipients', 'Recipients', 'missing', 'nobody to page — add a WhatsApp number in Admin → Subscribers'));

  const blocked = rungs.filter((r) => r.state === 'missing');
  const unknown = rungs.filter((r) => r.state === 'unknown');
  const state = blocked.length ? (s.enabled ? 'warn' : 'unknown') : unknown.length ? 'unknown' : 'ok';
  return {
    state, rungs,
    detail: blocked.length
      ? `not ready — ${blocked.map((r) => r.label.toLowerCase()).join(', ')}`
      : unknown.length
        ? `${rungs.length - unknown.length} of ${rungs.length} confirmed — ${unknown.map((r) => r.label.toLowerCase()).join(', ')} unverified`
        : 'ready — every rung confirmed',
    hint: blocked.length ? blocked[0].note
      : unknown.length ? 'Admin → Tools → "Check account & template" asks Meta directly; nothing here guesses.'
      : '',
  };
}

/** The readiness ladder as a Health check. Never CRIT: WhatsApp is a side
    channel and email is the one that must work — a red page over a secondary
    channel that has been blocked for a week trains its reader to ignore red. */
export function whatsappCheck(probe = {}) {
  const r = whatsappReadiness(probe);
  if (!whatsappStatus().enabled) {
    return { id: 'whatsapp', label: 'WhatsApp channel', state: 'unknown',
      detail: 'off — WHATSAPP_ENABLED is not set',
      hint: 'Deliberate while the channel is unusable. Email carries every alert either way.' };
  }
  return { id: 'whatsapp', label: 'WhatsApp channel', state: r.state, detail: r.detail, hint: r.hint };
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
  // Meta usually ALREADY opens the message with its own code — "(#131037)
  // WhatsApp provided number needs…" — so prefixing unconditionally printed it
  // twice. Add the code only when the message does not already carry it.
  const msg = String(err?.message || '').trim();
  const reason = !msg ? `HTTP ${r.status}`
    : (err.code && !msg.includes(String(err.code))) ? `#${err.code} ${msg}`
    : msg;
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
