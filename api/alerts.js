// Admin health + alert log. Backs Admin → Health.
//
//   GET /api/alerts            → { status, checks[], log[], logAvailable }
//   GET /api/alerts?notify=1   → the same, and emails when something is wrong
//
// Ops problems in PR Radar were previously invisible until someone noticed the
// absence of an email. Nothing on any surface answered "is the radar working
// right now" — the board looks identical whether the classifier is screening
// properly or the account has been rate-limited and every story is being parked
// unclassified. This gives the admin two things no inbox can:
//   * checks[] — computed NOW, so it answers "is the radar healthy this minute"
//   * log[]    — the persisted history of raised alerts (pr_alerts).
//
// Every probe is independently fail-soft: one unavailable table degrades that
// single check to state 'unknown' rather than 500-ing the whole page. Admin
// only — it exposes operational internals, not team content.

import {
  recentAlerts, parkedItemCount, lastItemSeenAt, ingestSummary, brokenFeeds,
  getStateTime, relevanceBaseline, authorBacklog, digestEligibleCount,
  activeSubscribers, monthToDateUsage, databaseSizeBytes,
} from '../lib/db.js';
import { totalCostUsd, cacheEfficiency } from '../lib/usage.js';
import { sendOpsAlert } from '../lib/email.js';
import { recentDeliveryStatus } from '../lib/deliverability.js';
import { requireRole } from '../lib/auth.js';

export const config = { maxDuration: 20 };

const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : null);
const fmtAge = (h) => {
  if (h == null) return 'never';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const pct = (r) => `${(r * 100).toFixed(1)}%`;

// The urgent poll runs every 15 min and the full run at 05:00 UTC, but Egyptian
// press is quiet overnight and a poll that finds only stories it has already
// stored writes nothing — so "last item" legitimately ages several hours before
// dawn. Thresholds are set off the observed floor (~55 items/day, 2 Aug 2026),
// not off the cron cadence, or this would be amber every morning.
const INGEST_WARN_H = 8;
const INGEST_CRIT_H = 20;

export default async function handler(req, res) {
  const who = await requireRole(req, res, 'admin');
  if (!who) return;   // 401/403 already sent
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const checks = [];
  const add = (c) => checks.push(c);

  // Run every probe in parallel; each settles independently so one missing
  // table can't blank the page.
  const [bulletinAt, lastSeen, ingest, parked, broken, log, quality, authors,
    digestable, subs, usage, inboxed, dbBytes] = await Promise.all([
      getStateTime('daily_bulletin_sent').catch(() => null),
      lastItemSeenAt().catch(() => undefined),
      ingestSummary({ hours: 24 }).catch(() => null),
      parkedItemCount({ days: 2 }).catch(() => null),
      brokenFeeds().catch(() => null),
      recentAlerts({ days: 14, limit: 100 }).catch(() => null),
      relevanceBaseline().catch(() => null),
      authorBacklog().catch(() => null),
      digestEligibleCount({ hours: 24 }).catch(() => null),
      activeSubscribers().catch(() => null),
      monthToDateUsage().catch(() => null),
      recentDeliveryStatus({ hours: 26 }).catch(() => null),
      databaseSizeBytes().catch(() => null),
    ]);

  // 1. DAILY BRIEF — the signal the team actually feels. Read together with the
  //    digest bar, because PR Radar sends NOTHING on a day where no story
  //    cleared importance 2 (api/radar.js builds the digest from relevant items
  //    at importance >= 2 and skips both send loops when it is empty). A stale
  //    marker on a quiet week is the system working; a stale marker with
  //    stories waiting is the failure. Reporting only the first would have this
  //    check sitting red through every quiet stretch until nobody read it.
  //    NOTE the marker is stamped when the brief reached ANYONE — a stale marker
  //    is not proof of a missed send; confirm against the provider before acting.
  if (bulletinAt == null) {
    add({ id: 'bulletin', label: 'Daily brief', state: 'unknown', detail: 'could not read the send marker' });
  } else {
    const h = bulletinAt ? hoursSince(new Date(bulletinAt).toISOString()) : null;
    const waiting = typeof digestable === 'number' ? digestable : null;
    const late = h == null || h > 26;
    // Nothing waiting → late is expected, not a fault.
    const state = !late ? 'ok' : waiting === null ? 'unknown' : waiting > 0 ? 'crit' : 'ok';
    const sent = h == null ? 'no send ever recorded' : `last sent ${fmtAge(h)}`;
    add({
      id: 'bulletin', label: 'Daily brief', state,
      detail: waiting === null ? sent
        : `${sent} · ${waiting} story(s) currently clear the Impact-2 bar`,
      hint: state === 'crit'
        ? 'Stories are waiting and no brief has gone out in over a day. Check the 05:00 UTC cron ran, then that it had recipients — Admin → Subscribers, or RADAR_TO. A stale marker alone is not proof of a missed send: confirm against the email provider before assuming the worst.'
        : late ? 'Nothing has cleared the Impact-2 bar, so there was no brief to send. This is the pipeline working, not failing.' : '',
    });
  }

  // 2. INGEST — feeds still landing? A stalled pipeline shows here first.
  if (lastSeen === undefined) {
    add({ id: 'ingest', label: 'Feed ingest', state: 'unknown', detail: 'could not read pr_items' });
  } else {
    const h = hoursSince(lastSeen);
    const vol = ingest ? ` · ${ingest.stored} stored / ${ingest.relevant} relevant in 24h` : '';
    add({
      id: 'ingest', label: 'Feed ingest',
      state: h == null || h > INGEST_CRIT_H ? 'crit' : h > INGEST_WARN_H ? 'warn' : 'ok',
      detail: `last new story ${fmtAge(h)}${vol}`,
      hint: h != null && h > INGEST_WARN_H
        ? 'The 15-minute poll stores nothing when every story it finds is already on the board, so a few quiet hours overnight are normal. This long means the runs are failing — check the Vercel function logs.'
        : '',
    });
  }

  // 3. CLASSIFICATION — a parked item is a story the classifier returned no
  //    verdict for. It is hidden everywhere (is_relevant:false), so a run where
  //    the API was rate-limited or the account capped looks completely normal on
  //    the board and completely normal in the logs. This is the only place it
  //    shows. Measured live 2 Aug 2026: 100 parked in 7 days, in bursts.
  if (parked == null) {
    add({ id: 'classify', label: 'Classification', state: 'unknown', detail: 'could not count parked items' });
  } else {
    add({
      id: 'classify', label: 'Classification',
      state: parked >= 20 ? 'crit' : parked > 0 ? 'warn' : 'ok',
      detail: parked > 0 ? `${parked} story(s) parked unclassified in 48h` : 'every story got a verdict',
      hint: parked > 0
        ? 'The model returned no verdict for these even after the pipeline re-asked for them individually, so they are hidden from the board and the brief. Check API errors and the spend cap first; a burst that is entirely off-topic wire copy is the model declining to answer for junk, which costs nothing but noise. They stay in pr_items (category "unclassified") and can be re-run.'
        : '',
    });
  }

  // 4. BRIEF RECIPIENTS — PR Radar has no per-recipient delivery ledger to
  //    report on, and the failure that keeps happening here is one step earlier:
  //    a brief with nowhere to go. RADAR_TO has been unset in production since
  //    22 Jul, which made the team copy a silent no-op; the subscriber list is
  //    the only thing keeping the brief alive. If BOTH are empty every send
  //    throws "no recipients", is caught, logged, and reaches nobody.
  const named = (process.env.RADAR_TO || '').split(',').map((s) => s.trim()).filter(Boolean).length;
  if (subs == null) {
    add({ id: 'recipients', label: 'Brief recipients', state: 'unknown', detail: 'could not read the subscriber list' });
  } else {
    const total = named + subs.length;
    add({
      id: 'recipients', label: 'Brief recipients',
      state: total === 0 ? 'crit' : 'ok',
      detail: total === 0
        ? 'nobody would receive the daily brief'
        : `${subs.length} subscriber(s)${named ? ` + ${named} on RADAR_TO` : ''}`,
      hint: total === 0
        ? 'Add someone in Admin → Subscribers. Every send would currently throw "no recipients", be caught and logged, and reach nobody.'
        : named === 0
          ? 'RADAR_TO is unset, so the team/admin copy of the brief does not go out — the subscriber list carries it. Adding people in Admin → Subscribers is the better route anyway: self-serve, filterable, no redeploy.'
          : '',
    });
  }

  // 5. FEED HEALTH — a dead feed is silent data loss: the board looks calm and
  //    the radar is blind in one direction.
  if (!broken) {
    add({ id: 'feeds', label: 'Feed health', state: 'unknown', detail: 'could not read feed health' });
  } else {
    const names = broken.map((b) => b.feed_id).filter(Boolean);
    add({
      id: 'feeds', label: 'Feed health',
      state: names.length ? 'warn' : 'ok',
      detail: names.length ? `${names.length} feed(s) with no success in 3+ days` : 'all feeds reporting',
      hint: names.slice(0, 8).join(', '),
    });
  }

  // 6. SCREENING QUALITY — the one thing every other check misses. The pipeline
  //    can run perfectly on time and brief the team on noise, or quietly stop
  //    surfacing anything; every light above stays green either way. Compared
  //    over whole weeks rather than day-on-day because PR Radar's daily rate
  //    swings 0%-12% on sampling noise alone (see relevanceBaseline).
  if (!quality) {
    add({ id: 'quality', label: 'Screening quality', state: 'unknown', detail: 'could not compute the relevance rate' });
  } else if (quality.recent.stored < 100 || quality.baseline.stored < 100 || quality.baseline.rate == null) {
    // Too little to judge — say so rather than implying health.
    add({
      id: 'quality', label: 'Screening quality', state: 'unknown',
      detail: `only ${quality.recent.stored} scanned in ${quality.windowDays}d vs ${quality.baseline.stored} before it — too few to judge`,
    });
  } else {
    const dev = (quality.recent.rate - quality.baseline.rate) / quality.baseline.rate;
    const state = dev <= -0.7 ? 'crit' : Math.abs(dev) >= 0.5 ? 'warn' : 'ok';
    const dir = dev < 0 ? 'below' : 'above';
    add({
      id: 'quality', label: 'Screening quality', state,
      detail: `${pct(quality.recent.rate)} relevant over ${quality.windowDays}d ` +
        `(${quality.recent.relevant}/${quality.recent.stored}) vs ${pct(quality.baseline.rate)} over the previous ${quality.baselineWeeks} weeks`,
      hint: state === 'ok' ? ''
        : `${Math.abs(dev * 100).toFixed(0)}% ${dir} the baseline. A collapse usually means a prompt change, a model change, or house knowledge in Context that has gone stale or contradictory; a spike means the screen has gone loose. Read a few cards on the board against last week's before changing anything.`,
    });
  }

  // 7. BYLINE BACKFILL — PR Radar's analogue of a review queue. Only about half
  //    of Egyptian stories carry an individual byline (wire and desk copy is
  //    unsigned), so "cards without an author" is never zero and is not itself a
  //    fault. What IS a fault is that number failing to fall: the daily sweep
  //    running but filling nothing means fetches are being blocked, and the
  //    journalist leaderboard quietly stops being representative.
  //    So this is judged on the RATE, not the count — a busy fortnight has more
  //    authorless cards without anything being wrong. 42% of relevant cards in
  //    the 14 days to 2 Aug 2026 had no byline; the bar is set at 75%, roughly
  //    double the norm, which no amount of ordinary wire copy reaches but a
  //    wholesale fetch block does immediately.
  if (!authors) {
    add({ id: 'authors', label: 'Byline backfill', state: 'unknown', detail: 'could not read the author backlog' });
  } else if (authors.relevant < 20) {
    add({
      id: 'authors', label: 'Byline backfill', state: 'unknown',
      detail: `only ${authors.relevant} card(s) in ${authors.days}d — too few to judge`,
    });
  } else {
    const share = authors.missing / authors.relevant;
    add({
      id: 'authors', label: 'Byline backfill',
      state: share >= 0.75 ? 'warn' : 'ok',
      detail: `${authors.missing} of ${authors.relevant} cards without a byline in ${authors.days}d (${pct(share)})` +
        `${authors.stale ? ` · ${authors.stale} past the ${authors.graceHours}h sweep window` : ''}`,
      hint: share >= 0.75
        ? 'Far above the ~40-50% that Egyptian wire and desk copy explains on its own — that pattern is fetches being blocked, not stories genuinely unsigned. Admin → Tools → "Verify verdicts" shows what each page actually returned; "Backfill authors" retries them.'
        : '',
    });
  }

  // 8. WEEKLY REPORT — a cron whose only symptom of death is absence. It is
  //    OFF by default (REPORT_EMAIL_ENABLED), and a disabled feature must read
  //    as disabled, not as broken: a check that is permanently amber for a
  //    deliberate setting teaches people to ignore the page.
  if (process.env.REPORT_EMAIL_ENABLED !== '1') {
    add({
      id: 'weekly', label: 'Weekly report email', state: 'ok',
      detail: 'off — the Monday cron runs and returns without sending',
      hint: 'Set REPORT_EMAIL_ENABLED=1 in the environment to switch it on. The report itself is always available at /reports.',
    });
  } else {
    const rNamed = (process.env.REPORT_TO || process.env.RADAR_TO || '').split(',').map((s) => s.trim()).filter(Boolean).length;
    add({
      id: 'weekly', label: 'Weekly report email',
      state: rNamed ? 'ok' : 'crit',
      detail: rNamed ? `on · ${rNamed} recipient(s), Mondays 06:00 UTC` : 'on, but no recipients configured',
      hint: rNamed ? '' : 'REPORT_EMAIL_ENABLED=1 with neither REPORT_TO nor RADAR_TO set — every Monday send throws and reaches nobody.',
    });
  }

  // 9. API SPEND — everything else here is reactive; this is the only
  //    forward-looking check. Projects month-end from the run rate so far,
  //    because "60% of the budget" means nothing without knowing it is the 8th.
  if (!usage) {
    add({ id: 'spend', label: 'API spend', state: 'unknown', detail: 'usage tracking not available (pr_usage not migrated)' });
  } else if (!usage.length) {
    add({ id: 'spend', label: 'API spend', state: 'unknown', detail: 'no usage recorded yet this month' });
  } else {
    const cap = Number(process.env.API_MONTHLY_CAP_USD) || 40;
    const spent = totalCostUsd(usage);
    const now = new Date();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected = spent / Math.max(1, dayOfMonth) * daysInMonth;
    const state = spent >= cap ? 'crit' : projected > cap ? 'warn' : 'ok';
    add({
      id: 'spend', label: 'API spend', state,
      detail: `~$${spent.toFixed(2)} of $${cap} · day ${dayOfMonth}/${daysInMonth} · tracking to ~$${projected.toFixed(0)}`,
      hint: state === 'ok' ? ''
        : `At this rate the month lands near $${projected.toFixed(0)}. Figures are estimates from recorded tokens and cover THIS app only — reconcile against the provider console, and remember the account may be shared.`,
    });
  }

  // 10. DELIVERABILITY — "sent" only means the provider ACCEPTED the call. This
  //     asks what actually happened to it. The recipients are a corporate
  //     domain, which is exactly where a gateway policy change silently
  //     swallows mail while every log line still reads fine.
  if (!inboxed || inboxed.error) {
    add({
      id: 'inbox', label: 'Deliverability', state: 'unknown',
      detail: inboxed?.error || 'could not read delivery status from the provider',
      hint: /send-only/.test(inboxed?.error || '')
        ? 'Create a full-access API key in the provider console and update RESEND_API_KEY. Sending is unaffected either way.'
        : '',
    });
  } else if (!inboxed.total) {
    add({ id: 'inbox', label: 'Deliverability', state: 'ok', detail: 'nothing sent in the last 26h' });
  } else {
    add({
      id: 'inbox', label: 'Deliverability',
      state: inboxed.bad > 0 ? 'warn' : 'ok',
      detail: inboxed.bad > 0
        ? `${inboxed.bad} of ${inboxed.total} did not reach an inbox`
        : `${inboxed.total} accepted and delivered (26h)`,
      hint: inboxed.bad > 0
        ? `Statuses: ${Object.entries(inboxed.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}. A gateway blocking the sending domain shows up here first, and every send would still have looked successful.`
        : '',
    });
  }

  // 11. STORAGE HEADROOM — the quietest failure here. The tier has a hard
  //     ceiling; hitting it means inserts fail and the board silently stops
  //     gaining stories. It is also the only failure with a months-long runway,
  //     so it is both easy to prevent and easy to never notice. The figure is
  //     the WHOLE database, which PR Radar shares with another app — the
  //     ceiling is shared, so the number that matters is the shared one.
  if (dbBytes == null) {
    add({ id: 'storage', label: 'Storage headroom', state: 'unknown', detail: 'db_size_bytes() not available in this project' });
  } else {
    const capMb = Number(process.env.DB_CAP_MB) || 500;
    const usedMb = dbBytes / 1048576;
    const used = usedMb / capMb;
    add({
      id: 'storage', label: 'Storage headroom',
      state: used >= 0.9 ? 'crit' : used >= 0.6 ? 'warn' : 'ok',
      detail: `${usedMb.toFixed(0)} MB of ${capMb} MB (${(used * 100).toFixed(0)}%) — whole project, shared with another app`,
      hint: used >= 0.6
        ? 'Prune the oldest rows before this bites. Check which app is growing first: the ceiling is shared, so the fix may not be in this repo.'
        : '',
    });
  }

  // 12. CACHE REUSE — caching is the main reason the screen is cheap
  //     (classify.js caches its system block on every batch). Break it and every
  //     cache WRITE is paid for and never amortised: the bill rises with no
  //     other symptom on this page or anywhere else.
  const cache = usage ? cacheEfficiency(usage, { hours: 24 }) : null;
  if (!cache) {
    add({ id: 'cache', label: 'Prompt cache', state: 'unknown', detail: 'not enough cached calls in 24h to judge' });
  } else {
    add({
      id: 'cache', label: 'Prompt cache',
      state: cache.ratio < 0.3 ? 'warn' : 'ok',
      detail: `${(cache.ratio * 100).toFixed(0)}% of cached tokens were reads (${cache.calls} calls)`,
      hint: cache.ratio < 0.3
        ? 'Reuse has collapsed — every call is re-writing the cache. Usually a system block that now varies per call (house knowledge edited mid-run, a timestamp) or runs spaced beyond the cache TTL.'
        : '',
    });
  }

  // Worst check wins for the page-level badge.
  const rank = { ok: 0, unknown: 1, warn: 2, crit: 3 };
  const status = checks.reduce((w, c) => (rank[c.state] > rank[w] ? c.state : w), 'ok');

  // ?notify=1 — PUSH. Twelve good checks are worthless if nobody opens the page,
  // so a scheduled trigger calls this and emails when something needs a look.
  //
  // Deduped against the alert LOG rather than a timer: the subject names the
  // failing checks, so an unchanged problem produces an identical title and is
  // suppressed, while a NEW check failing changes the title and alerts at once.
  // That is what stops a chronic condition (a dead feed nobody has got to yet)
  // from mailing every single day until it is ignored.
  let notified = null;
  if (req.query?.notify === '1') {
    const bad = checks.filter((c) => c.state === 'warn' || c.state === 'crit');
    if (!bad.length) {
      notified = { sent: false, reason: 'all clear' };
    } else {
      const worst = bad.some((c) => c.state === 'crit') ? 'critical' : 'warn';
      const title = `PR Radar health: ${bad.map((c) => c.label).join(', ')}`;
      const already = Array.isArray(log) && log.some(
        (a) => a.title === title && Date.now() - new Date(a.created_at).getTime() < 22 * 36e5
      );
      if (already) {
        notified = { sent: false, reason: 'already alerted in the last 22h' };
      } else {
        const lines = bad.map((c) => `${c.label}: ${c.detail}${c.hint ? `\n   → ${c.hint}` : ''}`);
        // sendOpsAlert writes the history row itself, before it sends, so the
        // alert is recorded even when the email is misconfigured or fails.
        const ok = await sendOpsAlert(title, lines, { severity: worst }).catch(() => false);
        notified = { sent: !!ok, reason: ok ? 'emailed' : 'no ops recipients configured, or the send failed' };
      }
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ...(notified ? { notified } : {}),
    generatedAt: new Date().toISOString(),
    status,
    checks,
    logAvailable: Array.isArray(log),
    log: Array.isArray(log) ? log : [],
  });
}
