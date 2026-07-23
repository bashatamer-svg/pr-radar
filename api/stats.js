// Server-aggregated trends for the /stats screen. Token-gated like api/items.js.
//
// GET /api/stats?t=<RADAR_TOKEN>&days=N  (N clamped 1..90, default 30)
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

// ── narrative clustering ──
// A "narrative" is several DISTINCT stories on one theme ("Vodafone Cash
// outage", "roaming price backlash") — not the dedupe pass (that collapses the
// SAME story). Group within a category by headline+summary token overlap, then
// name each cluster from its most frequent distinctive headline tokens.
const NARR_STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'by', 'with', 'from', 'as', 'that', 'this', 'these', 'those', 'says', 'said', 'has', 'have', 'will',
  'new', 'news', 'report', 'reports', 'after', 'over', 'amid', 'its', 'their', 'egypt', 'egyptian',
  'مصر', 'في', 'من', 'على', 'عن', 'إلى', 'الى', 'مع', 'بعد', 'خلال', 'حول', 'شركة',
]);
// Brand tokens steer clustering but are stripped from the generated NAME (the
// name shows the theme; the brand is a separate field/prefix).
const NARR_BRAND = new Set([
  'vodafone', 'فودافون', 'orange', 'اورنج', 'أورنج', 'we', 'وي', 'etisalat', 'اتصالات', 'telecom', 'e&',
]);
const narrTokens = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, ' ').split(/\s+/)
  .filter((w) => w.length >= 3 && !NARR_STOP.has(w));
// Distinctive tokens — long enough + non-brand — are what make two stories "the
// same theme" even when their overall wording barely overlaps ("roaming price"
// shared across otherwise-different headlines). Mirrors dedupe-semantic's
// strong-token bridge.
const strongToks = (s) => new Set([...narrTokens(s)].filter((w) => w.length >= 4 && !NARR_BRAND.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const sharedCount = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i; };
const titleCase = (s) => s.replace(/\b\p{L}/gu, (m) => m.toUpperCase());

// Cluster relevant items into named narratives with a per-day volume series,
// sentiment split, and a "rising" flag (accelerating in the back third of the
// window). Returns the top `limit` narratives, rising first.
function buildNarratives(items, days, dayIdx, { minStories = 2, threshold = 0.22, limit = 12 } = {}) {
  const clusters = [];
  for (const it of items) {
    const toks = new Set([...narrTokens(it.headline), ...narrTokens(it.summary)]);
    if (!toks.size) continue;
    const strong = strongToks(`${it.headline} ${it.summary}`);
    const cat = it.category || 'other';
    // Join the best same-category cluster that matches on EITHER overall overlap
    // (Jaccard ≥ threshold) OR ≥2 shared distinctive tokens; pick the strongest.
    let best = null, bestScore = 0;
    for (const c of clusters) {
      if (c.category !== cat) continue;
      const j = jaccard(c.tokens, toks);
      const sh = sharedCount(c.strong, strong);
      const score = Math.max(j, sh >= 2 ? 0.2 + 0.02 * sh : 0);
      if (score > bestScore && (j >= threshold || sh >= 2)) { bestScore = score; best = c; }
    }
    if (best) {
      best.items.push(it);
      for (const t of toks) best.tokens.add(t);
      for (const t of strong) best.strong.add(t);
    } else {
      clusters.push({ category: cat, tokens: new Set(toks), strong: new Set(strong), items: [it] });
    }
  }

  const zeros = () => days.map(() => 0);
  const out = [];
  for (const c of clusters) {
    if (c.items.length < minStories) continue;
    const series = zeros();
    let negative = 0, neutral = 0, positive = 0;
    const brandCount = {};
    const freq = new Map();
    for (const it of c.items) {
      const idx = dayIdx.get(dayOf(it));
      if (idx !== undefined) series[idx]++;
      const s = sentOf(it);
      if (s === 'negative') negative++; else if (s === 'positive') positive++; else neutral++;
      const b = brandOf(it);
      brandCount[b] = (brandCount[b] || 0) + 1;
      for (const t of new Set(narrTokens(it.headline))) if (!NARR_BRAND.has(t)) freq.set(t, (freq.get(t) || 0) + 1);
    }
    const brand = Object.entries(brandCount).sort((a, b) => b[1] - a[1])[0][0];
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const shared = ranked.filter(([, n]) => n >= 2).slice(0, 3).map(([t]) => t);
    const keyToks = (shared.length ? shared : ranked.slice(0, 2).map(([t]) => t));
    const rep = c.items.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))[0];
    const name = keyToks.length
      ? (brand === 'Market' ? '' : `${brand} · `) + titleCase(keyToks.join(' '))
      : String(rep.headline || c.category).split(/\s+/).slice(0, 6).join(' ');

    // rising: recent (back third) rate vs earlier rate.
    const cut = Math.floor(series.length * 2 / 3);
    const earlier = series.slice(0, cut).reduce((s, v) => s + v, 0);
    const recent = series.slice(cut).reduce((s, v) => s + v, 0);
    const earlierRate = earlier / Math.max(1, cut);
    const recentRate = recent / Math.max(1, series.length - cut);
    const rising = recent >= 2 && recentRate > earlierRate * 1.5;
    // Ratio only when there's a real baseline to divide by; a from-nothing
    // narrative reports null (the UI shows a plain "rising", not "400×").
    const risingScore = earlier > 0 ? Math.min(99, Math.round((recentRate / earlierRate) * 10) / 10) : null;

    out.push({
      name, brand, category: c.category, total: c.items.length,
      negative, neutral, positive, series, rising, risingScore,
      headline: rep.headline || null, ids: c.items.map((i) => i.id).filter(Boolean).slice(0, 20),
    });
  }
  return out
    .sort((a, b) => (Number(b.rising) - Number(a.rising)) || (b.risingScore - a.risingScore) || (b.total - a.total))
    .slice(0, limit);
}

export default async function handler(req, res) {
  const who = await requireRole(req, res, 'viewer');
  if (!who) return;

  const windowDays = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
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
    }
  }

  const categories = [...catAgg.values()].sort((a, b) => b.total - a.total);
  const outlets = [...outletAgg.values()]
    .sort((a, b) => b.vodNeg - a.vodNeg || b.negative - a.negative || b.mentions - a.mentions)
    .slice(0, 15);
  const authors = [...authorAgg.values()]
    .sort((a, b) => b.vodNeg - a.vodNeg || b.negative - a.negative || b.mentions - a.mentions)
    .slice(0, 15)
    .map((a) => ({ ...a, outlets: [...a.outlets].slice(0, 3) }));

  const narratives = buildNarratives(items, days, dayIdx);

  return res.status(200).json({
    meta: { days: windowDays, generatedAt: new Date().toISOString(), items: items.length },
    days,
    sov,                       // per-brand aligned arrays: mentions[] + negatives[] per day
    sentimentByBrand,
    categories,
    narratives,
    outlets,
    authors,
    totals: {
      items: items.length,
      negatives,
      positives,
      neutrals: items.length - negatives - positives,
      vodafone: { mentions: vodMentions, negatives: vodNegatives },
      distinctOutlets: outletAgg.size,
    },
  });
}
