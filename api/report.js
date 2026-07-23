// Weekly / monthly PR report — printable HTML + opt-in Resend send.
//
//   GET /api/report?t=<RADAR_TOKEN>&period=week            → printable HTML
//   GET /api/report?t=<RADAR_TOKEN>&period=month&days=30   → month view
//   GET /api/report?...&send=1                             → also email it,
//        but ONLY when REPORT_EMAIL_ENABLED=1 (off by default). A send request
//        with the flag unset returns the HTML plus a note; it never emails.
//
// Auth mirrors api/radar.js: RADAR_TOKEN (?t= or Bearer) for a human opening it,
// or CRON_SECRET (Bearer, injected by Vercel Cron) for the optional weekly cron
// in vercel.json. The cron passes &send=1, so it emails only when the env flag
// is on — the schedule can sit dormant until the team opts in.

import { buildReport, renderReport } from '../lib/report.js';
import { sendBulletin } from '../lib/email.js';
import { safeEqual } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Bearer only (no ?t= query token), constant-time.
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const ok =
    (process.env.CRON_SECRET && safeEqual(bearer, process.env.CRON_SECRET)) ||
    (process.env.RADAR_TOKEN && safeEqual(bearer, process.env.RADAR_TOKEN));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  // Period → window. ?days wins if given (clamped); else week=7 / month=30.
  const period = req.query?.period === 'month' ? 'month' : 'week';
  const days = Math.max(1, Math.min(Number(req.query?.days) || (period === 'month' ? 30 : 7), 92));

  let data;
  try {
    data = await buildReport({ days });
  } catch (e) {
    console.error('report build failed', e.message);
    return res.status(500).json({ error: 'report build failed', detail: e.message });
  }
  const html = renderReport(data, { period });

  // Opt-in email: default OFF. Only sends when the caller asked (send=1) AND
  // REPORT_EMAIL_ENABLED=1. Recipients: REPORT_TO, falling back to RADAR_TO.
  const wantSend = req.query?.send === '1';
  const enabled = process.env.REPORT_EMAIL_ENABLED === '1';
  let sent = false;
  let note = null;
  if (wantSend && enabled) {
    const to = process.env.REPORT_TO || process.env.RADAR_TO;
    const subject = `PR Radar — ${period === 'month' ? 'Monthly' : 'Weekly'} report · ${data.totals.items} items, ${data.totals.negatives} negative`;
    try {
      await sendBulletin(html, subject, to);
      sent = true;
    } catch (e) {
      console.error('report send failed', e.message);
      note = `send failed: ${e.message}`;
    }
  } else if (wantSend && !enabled) {
    note = 'REPORT_EMAIL_ENABLED not set — email skipped (printable report still returned)';
  }

  // A send request (cron or explicit) gets a JSON status; a plain view request
  // gets the printable HTML page.
  if (wantSend) {
    return res.status(200).json({ period, days, items: data.totals.items, negatives: data.totals.negatives, sent, note });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
