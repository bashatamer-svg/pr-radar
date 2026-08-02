// Did the brief actually ARRIVE?
//
// `sendBulletin` resolving without throwing means the email provider ACCEPTED
// our API call. That is not the same as delivered: a full mailbox, a corporate
// gateway that starts rejecting the sending domain, or a spam complaint all
// leave every log line reading "sent" while nobody receives anything. PR Radar
// mails a small, entirely corporate recipient list (@vodafone.com), which is
// exactly the population where a gateway policy change silently swallows mail.
//
// This asks the provider what actually happened. Read-only, and fail-soft: any
// error returns an { error } explaining WHY, so the health page reports
// 'unknown' with a cause rather than implying health it cannot verify.

const API = 'https://api.resend.com/emails';

// Provider statuses that mean the message did NOT land in an inbox. Verified
// against the provider SDK's own last_event enum:
// bounced | canceled | clicked | complained | delivered | delivery_delayed |
// failed | opened | queued | scheduled | sent | suppressed
// 'suppressed' means the address is on a suppression list — the message was
// never attempted, which is a silent non-delivery and the most important one to
// catch. 'sent'/'delivered'/'opened'/'clicked' are fine; queued/scheduled are
// in flight, not failures.
const BAD = new Set(['bounced', 'complained', 'failed', 'delivery_delayed', 'canceled', 'suppressed']);

// "Name <addr>" or a bare address → the address, lowercased. Used to compare
// RADAR_FROM against each row's `from`, which the provider also returns in
// either form.
const addrOf = (s) => {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
};

/** Summarise recent sends — PR RADAR'S ONLY, when RADAR_FROM is set.
 *  The provider account is shared with another app (its own daily bulletin is
 *  ~18 sends), so an unfiltered count answers "is the ACCOUNT delivering",
 *  which lets that app's bounce redden this app's health page and vice versa.
 *  Each app mails from its own address, so filter on ours; with RADAR_FROM
 *  unset there is nothing to filter by and the account-wide count stands.
 *  Returns { total, bad, byStatus, scope } on success, or { error } explaining
 *  why it could not be read. Never a bare null: "could not read" with no reason
 *  sends the next diagnosis hunting a response-shape bug when the likeliest
 *  cause is an API key with SEND-ONLY permission, which cannot list. */
export async function recentDeliveryStatus({ hours = 26, limit = 100 } = {}) {
  const ours = addrOf(process.env.RADAR_FROM);
  const key = process.env.RESEND_API_KEY;
  if (!key) return { error: 'no API key configured' };
  let payload;
  try {
    const res = await fetch(`${API}?limit=${Math.min(100, Math.max(1, limit))}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      // 401/403 almost always means the key is send-only. Say so: it is a
      // console setting, not a code fix, and guessing wastes an investigation.
      return {
        error: res.status === 401 || res.status === 403
          ? `provider returned ${res.status} — the API key is probably send-only and cannot list emails`
          : `provider returned ${res.status}`,
      };
    }
    payload = await res.json();
  } catch (e) {
    return { error: `could not reach the provider (${e.message})` };
  }
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!rows) return { error: 'unexpected response shape' };

  const since = Date.now() - hours * 36e5;
  const byStatus = {};
  let total = 0, bad = 0;
  for (const r of rows) {
    const at = Date.parse(r?.created_at ?? r?.sent_at ?? '');
    if (Number.isFinite(at) && at < since) continue;
    if (ours && addrOf(r?.from) !== ours) continue;
    const s = String(r?.last_event ?? r?.status ?? '').toLowerCase();
    if (!s) continue;
    byStatus[s] = (byStatus[s] || 0) + 1;
    total++;
    if (BAD.has(s)) bad++;
  }
  return { total, bad, byStatus, scope: ours ? 'pr-radar' : 'account' };
}
