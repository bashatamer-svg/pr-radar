// Are we about to run out of email?
//
// The provider enforces a hard send quota. Past it, sends are REFUSED — and
// because the urgent poll runs every 15 minutes, the next thing to be refused
// is whatever fires next, which on a bad day is a crisis alert. Nothing else on
// the health page can see this coming: `sendBulletin` would throw, `pr_alerts`
// would record the attempt, and every other check would stay green.
//
// TWO THINGS THIS FILE HAS TO GET RIGHT, and they are opposite to the ones next
// door in deliverability.js:
//
//   1. THE COUNT IS ACCOUNT-WIDE, ON PURPOSE. deliverability.js filters to
//      RADAR_FROM because "is OUR mail arriving" must not redden on the other
//      app's bounce. A QUOTA is the opposite: the ceiling is shared, so the
//      number that matters is the shared one. Filtering here would report ~40%
//      of the usage that will actually refuse our sends. Same call the storage
//      check makes with db_size_bytes(). Do not "fix" one to match the other.
//
//   2. THE CEILING IS CONFIGURATION, BECAUSE THE API HAS NO USAGE ENDPOINT.
//      There is nothing to ask: the provider exposes neither the plan nor the
//      counters, only the list of sent messages. So the caps are env vars, and
//      the DEFAULTS are the free tier — under-estimating a ceiling fails safe
//      (an early warning), over-estimating it stays green while sends bounce.
//
// Rolling windows, not calendar day/month. The provider does not publish when
// its counters reset, and a calendar-day count reads near-zero just after a
// reset while eighty messages went out in the hour before it — the exact moment
// you most need the warning. A rolling window cannot read low that way. It can
// read HIGH just after a burst that a reset has already forgiven, which is the
// safe direction for a tripwire.

const API = 'https://api.resend.com/emails';

const DAY_MS = 864e5;
export const WINDOW = { day: DAY_MS, month: 30 * DAY_MS };

// Free tier. Both overridable — set them to your plan's real numbers.
// A cap must be a POSITIVE number: zero or a negative would divide the usage
// into a percentage that reads healthy, which is the one way a ceiling check
// can fail silently. Anything else falls back to the documented default.
const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const caps = () => ({
  day: positive(process.env.RESEND_DAILY_CAP, 100),
  month: positive(process.env.RESEND_MONTHLY_CAP, 3000),
});

// Enough pages to count a full month at the default cap (100 rows a page), plus
// slack. Walking further cannot change the verdict: once the count is over the
// cap the exact figure is irrelevant, and the check says so rather than paying
// for precision nobody can act on.
const MAX_PAGES = () => Number(process.env.RESEND_COUNT_MAX_PAGES) || 34;
const PAGE = 100;

// A WALL-CLOCK budget as well as a page budget, and this one is the important
// one. Paging is sequential by construction (a cursor can only be followed),
// so a month is ~20 round trips — and `api/alerts.js` carries no maxDuration
// override in vercel.json, so it runs on the platform default rather than
// radar.js's 60s. A quota check that times out the health page has destroyed
// more than the blindness it was added to fix: same rule as lib/runs.js, where
// the ledger may never fail the job it watches. Out of budget, the walk stops
// and says the figure is a floor — which the check already knows how to report.
const BUDGET_MS = () => Number(process.env.RESEND_COUNT_BUDGET_MS) || 5000;

/** Count sends in the last 24h and the last 30d, in ONE backward walk.
 *
 *  The walk is newest-first, so the 24h figure is settled by the end of the
 *  first page and the rest of the pages are the month. Counting them separately
 *  would double the requests for a number already in hand.
 *
 *  Returns { day, month, complete, pages, oldestMs } or { error }. `complete`
 *  is false when the walk stopped before reaching 30 days back — then `month`
 *  is a FLOOR, and the caller must not read a floor under the threshold as
 *  being under the threshold.
 *
 *  Never throws. */
export async function countRecentSends({
  now = Date.now(), maxPages = MAX_PAGES(), budgetMs = BUDGET_MS(), clock = Date.now,
} = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { error: 'no API key configured' };
  const startedAt = clock();

  const cut = { day: now - WINDOW.day, month: now - WINDOW.month };
  let day = 0, month = 0, pages = 0, oldestMs = null, undated = 0;
  let cursor = null;
  let reachedBack = false;
  // A quota counts DISTINCT messages, so count distinct ids. Stopping the walk
  // when the cursor fails to advance is not enough on its own: by then the
  // repeated page has already been added, and one duplicated page of 100 is a
  // 100-message quota crisis that is not happening. Bounded by the page budget
  // (~3,400 ids at the default), which is nothing.
  const seen = new Set();

  while (pages < maxPages) {
    // Checked BEFORE the request, never after: the point is not to start a
    // round trip that could push the page past its function limit.
    if (pages > 0 && clock() - startedAt >= budgetMs) break;
    const url = `${API}?limit=${PAGE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    let payload;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) {
        // Same cause and same wording as deliverability.js: a send-only key
        // cannot list, and that is a console setting rather than a code fix.
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
    pages++;
    if (!rows.length) { reachedBack = true; break; }

    for (const r of rows) {
      if (r?.id) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      const at = Date.parse(r?.created_at ?? r?.sent_at ?? '');
      if (!Number.isFinite(at)) { undated++; continue; }
      if (oldestMs == null || at < oldestMs) oldestMs = at;
      if (at >= cut.month) month++;
      if (at >= cut.day) day++;
    }

    // Past the far edge of the widest window, or the provider has no more.
    if (oldestMs != null && oldestMs < cut.month) { reachedBack = true; break; }
    if (rows.length < PAGE) { reachedBack = true; break; }

    // Cursor-based paging can only go one way, and a provider that ignores the
    // cursor would hand back page one forever — 34 identical pages counted 34
    // times reads as a quota crisis that is not happening. Stop instead.
    const next = rows[rows.length - 1]?.id;
    if (!next || next === cursor) break;
    cursor = next;
  }

  // An undated row cannot be placed in a window, so it is counted in neither —
  // which makes both figures floors, the same as running out of pages.
  return { day, month, pages, oldestMs, complete: reachedBack && !undated, undated };
}

/** The health check. Pure, so the thresholds are testable without a provider. */
export function emailQuotaCheck(counts) {
  const id = 'quota', label = 'Email quota';
  const { day: dayCap, month: monthCap } = caps();

  if (!counts || counts.error) {
    return {
      id, label, state: 'unknown',
      detail: counts?.error || 'could not read the send count from the provider',
      hint: /send-only/.test(counts?.error || '')
        ? 'Create a full-access API key in the provider console and update RESEND_API_KEY. Sending is unaffected either way.'
        : 'Unknown is not "fine" — over the quota the provider REFUSES sends, and with the urgent poll running every 15 minutes the next refusal is whatever fires next.',
    };
  }

  const pct = (n, cap) => (cap > 0 ? n / cap : 0);
  const dayPct = pct(counts.day, dayCap);
  const monthPct = pct(counts.month, monthCap);
  const worst = Math.max(dayPct, monthPct);
  // 80% is the ask: enough runway to change something before sends start
  // failing. 95% is its own rung because at that point a single alert fan-out
  // (one email PER RECIPIENT, by design) crosses the line on its own.
  const state = worst >= 0.95 ? 'crit' : worst >= 0.8 ? 'warn' : 'ok';

  const pctTxt = (p) => `${Math.round(p * 100)}%`;
  const floor = counts.complete ? '' : '≥';
  const detail =
    `${counts.day} of ${dayCap} in 24h (${pctTxt(dayPct)}) · ` +
    `${floor}${counts.month} of ${monthCap} in 30d (${floor}${pctTxt(monthPct)}) — whole account, shared with another app`;

  const parts = [];
  if (state !== 'ok') {
    parts.push(
      'Past the cap the provider refuses sends: the daily brief, and the urgent alerts that poll every 15 minutes. ' +
      'Every alert is ONE EMAIL PER RECIPIENT by design, so a single alert costs as many sends as there are people on the list. ' +
      'Raise the plan, or cut the recipient list — and check which app is spending it first, because the ceiling is shared and the fix may not be in this repo.');
  }
  if (!counts.complete) {
    parts.push(
      `The 30-day figure is a FLOOR — the walk stopped after ${counts.pages} page(s)` +
      `${counts.undated ? ` and ${counts.undated} row(s) carried no timestamp` : ''}, ` +
      'so the real number is at least this. A floor can only push this check UP, never down: ' +
      `a ${state === 'ok' ? 'warn or crit' : 'warning'} here is real, and an "ok" means the 24h figure is fine ` +
      '(it settles on the first page) while the 30-day one could not be established.');
  }
  if (!process.env.RESEND_DAILY_CAP && !process.env.RESEND_MONTHLY_CAP) {
    parts.push(
      `Caps are the free tier (${dayCap}/day, ${monthCap}/30d) because the provider exposes no plan or usage endpoint. ` +
      'Set RESEND_DAILY_CAP / RESEND_MONTHLY_CAP to your real plan — the defaults under-estimate on purpose, so a wrong one warns early rather than staying green while sends bounce.');
  }
  return { id, label, state, detail, hint: parts.join(' ') };
}
