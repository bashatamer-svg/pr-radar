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
  const token = req.query.t || req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.RADAR_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const windowDays = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
  const items = await itemsForStats({ days: windowDays });

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
        if (!outletAgg.has(outlet.toLowerCase())) outletAgg.set(outlet.toLowerCase(), { outlet, mentions: 0, negative: 0, vodNeg: 0 });
        const o = outletAgg.get(outlet.toLowerCase());
        o.mentions++;
        if (neg) { o.negative++; if (b === 'Vodafone') o.vodNeg++; }
      }
      const author = String(r.author || '').trim();
      // Skip empty bylines and outlet-names-as-bylines — a publication is not a person.
      if (!author || author === '—' || isOutletName(author, outlet || it.source)) continue;
      if (seenAuthor.has(author.toLowerCase())) continue;
      seenAuthor.add(author.toLowerCase());
      if (!authorAgg.has(author.toLowerCase())) authorAgg.set(author.toLowerCase(), { author, mentions: 0, negative: 0, vodNeg: 0, outlets: new Set() });
      const a = authorAgg.get(author.toLowerCase());
      a.mentions++;
      if (neg) { a.negative++; if (b === 'Vodafone') a.vodNeg++; }
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

  return res.status(200).json({
    meta: { days: windowDays, generatedAt: new Date().toISOString(), items: items.length },
    days,
    sov,                       // per-brand aligned arrays: mentions[] + negatives[] per day
    sentimentByBrand,
    categories,
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
