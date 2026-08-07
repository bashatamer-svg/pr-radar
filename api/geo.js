// AI answer-engine (GEO) monitoring endpoint.
//
// OPERATOR-gated (CRON_SECRET or a signed-in admin) — running the check calls
// out to paid answer engines and can email the findings, so the shared
// read-only RADAR_TOKEN is refused here. See the model in lib/auth.js.
//
//   GET /api/geo                          → run the check, return JSON findings
//   GET /api/geo?send=1                   → also email the flagged findings,
//        but ONLY when GEO_ALERTS_ENABLED=1 (the cron passes send=1).
//
// The whole feature is OFF until GEO_ENABLED=1 (runGeoCheck returns enabled:false
// and makes zero external calls otherwise), and each engine stays dormant until
// its own API key is set — so this can ship dark and cost nothing.

import { runGeoCheck, renderGeoEmail } from '../lib/geo.js';
import { sendBulletin } from '../lib/email.js';
import { requireOperator } from '../lib/auth.js';
import { startRun, JOBS } from '../lib/runs.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Bearer only (no ?t= query token). CRON_SECRET or a signed-in admin.
  const who = await requireOperator(req, res);
  if (!who) return;   // 401/403 already sent

  const run = await startRun(JOBS.geo);
  let result;
  try {
    result = await runGeoCheck();
  } catch (e) {
    console.error('geo check failed', e.message);
    await run?.fail(e);
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

  await run?.ok({ stored: result.checked, relevant: result.flagged, alerts: sent ? 1 : 0 });

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
