// AI answer-engine (GEO) monitoring endpoint. Token-gated like api/items.js,
// plus CRON_SECRET for the optional scheduled check.
//
//   GET /api/geo?t=<RADAR_TOKEN>          → run the check, return JSON findings
//   GET /api/geo?...&send=1               → also email the flagged findings,
//        but ONLY when GEO_ALERTS_ENABLED=1 (the cron passes send=1).
//
// The whole feature is OFF until GEO_ENABLED=1 (runGeoCheck returns enabled:false
// and makes zero external calls otherwise), and each engine stays dormant until
// its own API key is set — so this can ship dark and cost nothing.

import { runGeoCheck, renderGeoEmail } from '../lib/geo.js';
import { sendBulletin } from '../lib/email.js';
import { safeEqual } from '../lib/auth.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Bearer only (no ?t= query token), constant-time.
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const ok =
    (process.env.CRON_SECRET && safeEqual(bearer, process.env.CRON_SECRET)) ||
    (process.env.RADAR_TOKEN && safeEqual(bearer, process.env.RADAR_TOKEN));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  let result;
  try {
    result = await runGeoCheck();
  } catch (e) {
    console.error('geo check failed', e.message);
    return res.status(500).json({ error: 'geo check failed', detail: e.message });
  }

  // Opt-in email: default OFF. Sends only when asked (send=1) AND
  // GEO_ALERTS_ENABLED=1 AND something was actually flagged. Recipients:
  // GEO_TO, falling back to RADAR_TO.
  const wantSend = req.query?.send === '1';
  const enabled = process.env.GEO_ALERTS_ENABLED === '1';
  let sent = false, note = null;
  if (wantSend && enabled && result.enabled && result.flagged > 0) {
    const to = process.env.GEO_TO || process.env.RADAR_TO;
    const subject = `GEO — ${result.flagged} AI answer${result.flagged === 1 ? '' : 's'} flagged about Vodafone Egypt`.slice(0, 140);
    try {
      await sendBulletin(renderGeoEmail(result, process.env.BOARD_URL || ''), subject, to);
      sent = true;
    } catch (e) { console.error('geo email failed', e.message); note = `send failed: ${e.message}`; }
  } else if (wantSend && !enabled) {
    note = 'GEO_ALERTS_ENABLED not set — email skipped';
  } else if (wantSend && result.flagged === 0) {
    note = 'nothing flagged — no email';
  }

  // Summary for the cron/JSON caller; full findings for an interactive check.
  return res.status(200).json({
    enabled: result.enabled,
    engines: result.engines,
    checked: result.checked,
    flagged: result.flagged,
    note: result.note || note || undefined,
    sent,
    findings: wantSend ? undefined : result.findings,
  });
}
