// Server-aggregated trends for the /stats screen. Token-gated like api/items.js.
//
// GET /api/stats?days=N            (N clamped 1..90, default 30). Viewer+, Bearer only.
// GET /api/stats?view=narratives&days=N   → { narratives } and nothing else.
//
// WHY TWO CALLS. This endpoint used to `await buildNarratives()` inline, and
// that awaits Anthropic with a 12-second ceiling. Trends is a PAGE LOAD, so on
// a cold request every chart on the screen — share of voice, sentiment,
// categories, both leaderboards, the KPI row — waited on an LLM that contributes
// exactly one card. The whole screen was as slow as its slowest optional part.
//
// Now the main call returns the core aggregates plus the DETERMINISTIC token
// clustering, which is free (stage 1 runs either way) and already useful, so the
// narrative card is populated on first paint rather than empty. The browser then
// asks for ?view=narratives, which runs the LLM pass and swaps in the better
// grouping. If that second call is slow, fails, or the key is unset, the page
// keeps the stage-1 answer and nothing is missing — the same fail-soft
// behaviour buildNarratives always had, moved off the critical path.
//
// Aggregation happens HERE, not in the browser: the board ships raw rows because
// it renders cards, but a 90-day trend over items × instances would be a heavy,
// slow payload — and the aggregates must match however the server counts, so
// there is exactly one counting implementation. Everything reuses the board's
// window predicate (is_relevant, published_at falling back to seen_at) so the
// stats reconcile with what the board shows for the same window.

import { itemsForStats, instancesForItems } from '../lib/db.js';
import { isOutletName } from '../lib/author.js';
import { requireRole } from '../lib/auth.js';
import { buildNarratives } from '../lib/narratives.js';

const BRANDS = ['Vodafone', 'Orange', 'WE', 'e&'];
const SERIES = [...BRANDS, 'Market'];               // fixed order — stack + legend order
const brandOf = (it) => (BRANDS.includes(it.brand) ? it.brand : 'Market');
// Same fallback as the board's sentOf(): unknown/null reads as neutral.
const sentOf = (it) => (it.sentiment === 'negative' || it.sentiment === 'positive' ? it.sentiment : 'neutral');

// Bucket days in Cairo time — the team's mental "today", matching the bulletin.
const cairoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dayOf = (it) => {
  const t = it.published_at || it.seen_at;
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : cairoDay.format(d);
};

export default async function handler(req, res) {
  const who = await requireRole(req, res, 'viewer');
  if (!who) return;

  const windowDays = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
  const narrativesOnly = req.query.view === 'narratives';
  const items = await itemsForStats({ days: windowDays, withText: true });

  // Continuous Cairo-day axis, oldest → today. Stepping UTC-24h through a DST
  // change can emit a duplicate local day; the Set dedupes it.
  const days = [];
  const seenDays = new Set();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = cairoDay.format(new Date(Date.now() - i * 864e5));
    if (!seenDays.has(d)) { seenDays.add(d); days.push(d); }
  }
  const dayIdx = new Map(days.map((d, i) => [d, i]));

  // ── ?view=narratives — the LLM pass, on its own ──────────────────────────
  // Returned as its own response so the charts never wait on it. Everything a
  // narrative row needs (ids, idsTotal, series, sentiment split, rising) is in
  // here, so the deep link behaves identically to when this rode the main
  // payload — the board still opens exactly these ids and still learns the true
  // count from idsTotal.
  if (narrativesOnly) {
    let narratives = [];
    try { narratives = await buildNarratives(items, days, dayIdx); }
    catch (e) { console.error('narratives failed, section omitted —', e.message); }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      meta: { days: windowDays, generatedAt: new Date().toISOString(), items: items.length },
      narratives,
    });
  }

  // Coverage instances for the outlet/author leaderboards. Chunked — a 90-day
  // window can hold 1000+ ids and one giant in.() list overflows the URL.
  // Fail-soft: on error the leaderboards fall back to the items' own
  // source/author columns instead of failing the whole response.
  const instMap = {};
  try {
    const ids = items.map((i) => i.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 150) {
      Object.assign(instMap, await instancesForItems(ids.slice(i, i + 150)));
    }
  } catch (e) {
    console.error('stats instances fetch failed (leaderboards degrade)', e.message);
  }

  // ── aggregate ──
  const zeros = () => days.map(() => 0);
  const sov = {};
  for (const b of SERIES) sov[b] = { mentions: zeros(), negatives: zeros() };
  const sentimentByBrand = {};
  for (const b of SERIES) sentimentByBrand[b] = { negative: 0, neutral: 0, positive: 0, total: 0 };
  const catAgg = new Map();     // category -> {total, negative, vodNeg, series[]}
  const outletAgg = new Map();  // outlet lower -> {outlet, mentions, negative, vodNeg}
  const authorAgg = new Map();  // author lower -> {author, mentions, negative, vodNeg, outlets:Set}

  let negatives = 0, positives = 0, vodMentions = 0, vodNegatives = 0;
  const bylinedItems = new Set();   // stories carrying at least one real byline

  for (const it of items) {
    const b = brandOf(it);
    const s = sentOf(it);
    const neg = s === 'negative';
    const idx = dayIdx.get(dayOf(it));      // undefined when Cairo offset lands just outside the axis

    if (neg) negatives++;
    if (s === 'positive') positives++;
    if (b === 'Vodafone') { vodMentions++; if (neg) vodNegatives++; }

    sentimentByBrand[b][s]++;
    sentimentByBrand[b].total++;
    if (idx !== undefined) {
      sov[b].mentions[idx]++;
      if (neg) sov[b].negatives[idx]++;
    }

    const cat = it.category || 'other';
    if (!catAgg.has(cat)) catAgg.set(cat, { category: cat, total: 0, negative: 0, vodNeg: 0, series: zeros() });
    const c = catAgg.get(cat);
    c.total++;
    if (neg) { c.negative++; if (b === 'Vodafone') c.vodNeg++; }
    if (idx !== undefined) c.series[idx]++;

    // One story counts once per outlet / per author, however many coverage rows
    // it carries. Items with no stored instances fall back to their own
    // source/author so older rows still count.
    const insts = instMap[it.id];
    const rows = insts && insts.length ? insts : [{ outlet: it.source, author: it.author }];
    const seenOutlet = new Set();
    const seenAuthor = new Set();
    for (const r of rows) {
      const outlet = String(r.outlet || '').trim();
      if (outlet && !seenOutlet.has(outlet.toLowerCase())) {
        seenOutlet.add(outlet.toLowerCase());
        if (!outletAgg.has(outlet.toLowerCase())) outletAgg.set(outlet.toLowerCase(), { outlet, mentions: 0, negative: 0, neutral: 0, positive: 0, vodNeg: 0, series: zeros() });
        const o = outletAgg.get(outlet.toLowerCase());
        o.mentions++;
        o[s]++;                                     // sentiment-by-outlet split
        if (neg && b === 'Vodafone') o.vodNeg++;
        if (idx !== undefined) o.series[idx]++;     // activity over time
      }
      const author = String(r.author || '').trim();
      // Skip empty bylines and outlet-names-as-bylines — a publication is not a person.
      if (!author || author === '—' || isOutletName(author, outlet || it.source)) continue;
      if (seenAuthor.has(author.toLowerCase())) continue;
      seenAuthor.add(author.toLowerCase());
      if (!authorAgg.has(author.toLowerCase())) authorAgg.set(author.toLowerCase(), { author, mentions: 0, negative: 0, neutral: 0, positive: 0, vodNeg: 0, outlets: new Set(), series: zeros() });
      const a = authorAgg.get(author.toLowerCase());
      a.mentions++;
      a[s]++;                                        // sentiment-by-author split
      if (neg && b === 'Vodafone') a.vodNeg++;
      if (idx !== undefined) a.series[idx]++;
      if (outlet) a.outlets.add(outlet);
      bylinedItems.add(it.id);
    }
  }

  const categories = [...catAgg.values()].sort((a, b) => b.total - a.total);
  // The FULL leaderboards ship: the Trends page pages through them 15 at a time
  // in the browser, so flipping costs no request and no re-aggregation (which
  // would mean redoing the narrative LLM pass just to return 15 other rows).
  // The cap is only a payload backstop — a 90-day window runs to ~130 outlets,
  // nowhere near it — and totals.distinct* still carry the true counts, so if
  // it ever does trip the UI keeps saying "top N of M" instead of quietly
  // truncating.
  const LEADERBOARD_MAX = 300;
  const outlets = [...outletAgg.values()]
    .sort((a, b) => b.vodNeg - a.vodNeg || b.negative - a.negative || b.mentions - a.mentions)
    .slice(0, LEADERBOARD_MAX);
  const authors = [...authorAgg.values()]
    .sort((a, b) => b.vodNeg - a.vodNeg || b.negative - a.negative || b.mentions - a.mentions)
    .slice(0, LEADERBOARD_MAX)
    .map((a) => ({ ...a, outlets: [...a.outlets].slice(0, 3) }));

  // The DETERMINISTIC clustering only (`ai: false`) — no Anthropic call, no
  // 12-second ceiling on a page load. Stage 1 runs either way, so this costs
  // nothing beyond what the endpoint already did, and it means the narrative
  // card has real content on first paint instead of a spinner.
  //
  // Fail-soft as before: narratives are one card, never a reason the whole
  // screen 500s.
  let narratives = [];
  try { narratives = await buildNarratives(items, days, dayIdx, { ai: false }); }
  catch (e) { console.error('narratives failed, section omitted —', e.message); }

  return res.status(200).json({
    meta: { days: windowDays, generatedAt: new Date().toISOString(), items: items.length },
    days,
    sov,                       // per-brand aligned arrays: mentions[] + negatives[] per day
    sentimentByBrand,
    categories,
    narratives,
    // Tells the browser an LLM regrouping is worth asking for. False with no
    // API key, so a deployment without one never fires a request that can only
    // return what it already has.
    narrativesPending: !!process.env.ANTHROPIC_API_KEY && narratives.length > 0,
    outlets,
    authors,
    totals: {
      items: items.length,
      negatives,
      positives,
      neutrals: items.length - negatives - positives,
      vodafone: { mentions: vodMentions, negatives: vodNegatives },
      distinctOutlets: outletAgg.size,
      distinctAuthors: authorAgg.size,
      // Most Egyptian wire/desk copy carries no individual byline, so the number
      // of stories will always dwarf the number of journalists. Surfaced so the
      // UI can explain the gap rather than leave it looking like missing data.
      itemsWithByline: bylinedItems.size,
    },
  });
}
