// PR report — printable HTML, Word download, opt-in Resend send.
//
//   GET /api/report?period=week                    → printable weekly HTML
//   GET /api/report?period=month&days=30           → month view
//   GET /api/report?from=2026-07-01&to=2026-07-27  → CUSTOM range (Cairo days,
//        inclusive) with executive summary + full coverage-log appendix
//   …&format=doc                                   → same report as a Word
//        (.doc) download — Word-flavoured HTML, no libraries, opens natively
//   …&send=1                                       → also email it (admins /
//        cron only), and ONLY when REPORT_EMAIL_ENABLED=1.
//
// Auth: any signed-in user (viewer+) can VIEW/EXPORT — requireRole('viewer')
// also accepts the RADAR_TOKEN (read-only) and CRON_SECRET service bearers.
// The EMAIL send stays admin-only (cron's CRON_SECRET maps to a service admin).

import { buildReport, buildReportRange, parseCairoRange, renderReport } from '../lib/report.js';
import { sendBulletin } from '../lib/email.js';
import { requireRole } from '../lib/auth.js';
import { startRun, JOBS } from '../lib/runs.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const who = await requireRole(req, res, 'viewer');
  if (!who) return; // 401/403 already sent

  const wantSend = req.query?.send === '1';
  const format = req.query?.format === 'doc' ? 'doc' : 'html';
  const from = req.query?.from, to = req.query?.to;

  let data, opts;
  try {
    if (from || to) {
      // Custom range: exec summary + appendix, titled by its dates.
      const range = parseCairoRange(from, to);
      data = await buildReportRange(range);
      const fmt = (ms, y) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}), timeZone: 'Africa/Cairo' });
      const rangeText = `${fmt(range.fromMs, false)} – ${fmt(range.toMs - 1, true)}`;
      opts = { title: 'Coverage report', rangeText, appendix: true, period: 'custom' };
    } else {
      const period = req.query?.period === 'month' ? 'month' : 'week';
      const days = Math.max(1, Math.min(Number(req.query?.days) || (period === 'month' ? 30 : 7), 92));
      data = await buildReport({ days });
      opts = { period };
    }
  } catch (e) {
    const bad = /must be|invalid date|before the|limited to/.test(e.message);
    if (!bad) console.error('report build failed', e.message);
    return res.status(bad ? 400 : 500).json({ error: bad ? e.message : 'report build failed' });
  }
  const html = renderReport(data, opts);

  // Opt-in email: default OFF; admin/cron only; needs REPORT_EMAIL_ENABLED=1.
  if (wantSend) {
    if (who.role !== 'admin') return res.status(403).json({ error: 'sending the report is admin-only' });
    // Only the SEND path is the Monday job. Viewing or exporting a report is a
    // person reading a page, and recording it would bury the weekly fire.
    const run = await startRun(JOBS.report);
    const enabled = process.env.REPORT_EMAIL_ENABLED === '1';
    let sent = false, note = null;
    if (enabled) {
      const to2 = process.env.REPORT_TO || process.env.RADAR_TO;
      const subject = `PR Radar — ${opts.title || (opts.period === 'month' ? 'Monthly' : 'Weekly')} report · ${data.totals.items} items, ${data.totals.negatives} negative`;
      try { await sendBulletin(html, subject, to2); sent = true; }
      catch (e) { console.error('report send failed', e.message); note = `send failed: ${e.message}`; }
    } else {
      note = 'REPORT_EMAIL_ENABLED not set — email skipped (printable report still returned)';
    }
    // A dormant flag is a SUCCESSFUL run of a job that is switched off, not a
    // failure — the cron fired, did what it is configured to do, and returned.
    await run?.ok({ stored: data.totals.items, relevant: data.totals.negatives, alerts: sent ? 1 : 0 });
    return res.status(200).json({ period: opts.period, days: data.days, items: data.totals.items, negatives: data.totals.negatives, sent, note });
  }

  if (format === 'doc') {
    // Word-flavoured HTML: Word (and Google Docs) open it natively — zero deps.
    // The Office namespaces + mso print-view block make Word treat it as a
    // print-layout document rather than "web layout".
    const doc = html
      .replace('<html lang="en"', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="en"')
      .replace('<head>', `<head><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->`);
    const name = from && to ? `pr-radar-report-${from}-to-${to}.doc` : `pr-radar-report-${data.days}d.doc`;
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.status(200).send(doc);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
