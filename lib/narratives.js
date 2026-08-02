// Narrative clustering — grouping the window's DISTINCT stories into the
// handful of threads a comms team would actually name ("the Al-Ahly stadium
// sponsorship", "the price-rise backlash"). Not the dedupe pass: dedupe
// collapses the SAME story reported twice; this groups different stories that
// belong to one running thread.
//
// Two stages, because neither alone is good enough:
//
//   1. A cheap deterministic pre-pass groups obvious neighbours by shared
//      distinctive vocabulary. It is fast, free, and never wrong about tight
//      pairs — but it cannot tell that "Vodafone LAUNCHES stadium naming" and
//      "prosecution service LAUNCHES on Ana Vodafone" are different events, and
//      it names clusters by stacking frequent tokens ("الأهلي الشراكة استاد"),
//      which reads as keyword salad rather than a title.
//   2. An LLM pass then re-groups and titles them. It is the part that knows a
//      melody-plagiarism row is not the sponsorship story, and that the same
//      thread split across the classifier's categories is still one thread.
//
// Stage 2 is FAIL-SOFT and OPTIONAL: no API key, a network error, a malformed
// reply, or an unrecognised id and we keep stage 1's answer. The screen always
// renders. Results are memoised per (window, exact id set) because /api/stats
// is an interactive page load and the same window is re-requested constantly.

import { recordUsage } from './usage.js';

const MODEL = process.env.NARRATIVE_MODEL || process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const AI_TIMEOUT_MS = Number(process.env.NARRATIVE_TIMEOUT_MS) || 12000;

// How many item ids a narrative hands the board's ?ids= deep link. Must stay
// <= the cap inside itemsByIds() (lib/db.js), which is what actually fetches
// them — a bigger number here would ask for rows the API refuses to return.
export const NARR_IDS_MAX = 100;

const BRANDS = ['Vodafone', 'Orange', 'WE', 'e&'];
const brandOf = (it) => (BRANDS.includes(it.brand) ? it.brand : 'Market');
const sentOf = (it) => (it.sentiment === 'negative' || it.sentiment === 'positive' ? it.sentiment : 'neutral');

const NARR_STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'by', 'with', 'from', 'as', 'that', 'this', 'these', 'those', 'says', 'said', 'has', 'have', 'will',
  'new', 'news', 'report', 'reports', 'after', 'over', 'amid', 'its', 'their', 'egypt', 'egyptian',
  'مصر', 'في', 'من', 'على', 'عن', 'إلى', 'الى', 'مع', 'بعد', 'خلال', 'حول', 'شركة',
]);
// Brand tokens steer clustering but are stripped from the generated NAME (the
// name shows the theme; the brand is a separate field/prefix).
const NARR_BRAND = new Set([
  'vodafone', 'فودافون', 'ڤودافون', 'orange', 'اورنج', 'أورنج', 'we', 'وي', 'etisalat', 'اتصالات', 'telecom', 'e&',
  // Company-name morphology: "المصرية للاتصالات" is Telecom Egypt's NAME — its
  // two words were counting as two shared "theme" tokens and glued every WE
  // corporate story together.
  'المصرية', 'للاتصالات', 'والاتصالات',
  'cash', 'كاش',   // product token: "Vodafone Cash" steers like a brand, it isn't a theme
]);
// Generic sector vocabulary. In a MOBILE-market monitor every second story says
// "mobile", "operators", "four", "network", "service" — so these can never make
// two stories "the same theme". Excluded from the distinctive-token bridge AND
// from generated cluster names.
const NARR_GENERIC = new Set([
  'mobile', 'phone', 'phones', 'operator', 'operators', 'network', 'networks',
  'four', 'major', 'service', 'services', 'company', 'companies', 'customers',
  'app', 'apps', 'digital', 'launch', 'launches', 'launched', 'announces', 'announced',
  'million', 'billion', 'first', 'largest', 'through', 'across',
  // Corporate-PR filler — every partnership/deal story says these, so they can't
  // link two stories ("strategic partnership", "implementation", "agreement"
  // merged TE's unified-card story with Orange's carry-on project).
  'implementation', 'cooperation', 'partnership', 'partnerships', 'strategic',
  'project', 'projects', 'agreement', 'agreements', 'discuss', 'discusses', 'discussed', 'government',
  'محمول', 'المحمول', 'موبايل', 'شبكة', 'شبكات', 'خدمة', 'خدمات', 'شركات', 'الشركات',
  'هاتف', 'الهاتف', 'عملاء', 'العملاء', 'مليون', 'مليار',
  'شراكة', 'تعاون', 'التعاون', 'استراتيجية', 'استراتيجي', 'اتفاقية', 'اتفاق',
  // Arabic PR verbs and filler nouns. Their English twins were already banned,
  // but the Arabic side was not — so "تطلق" (launches) alone glued the stadium
  // naming to the prosecution-services rollout, and the cluster was NAMED
  // "تطلق". Announcement verbs and "project/digital/smart/develop" describe
  // the SHAPE of a press release, never which story it is.
  'تطلق', 'أطلق', 'اطلق', 'يطلق', 'إطلاق', 'الإطلاق',
  'تعلن', 'أعلن', 'اعلن', 'يعلن', 'الإعلان', 'إعلان', 'اعلان',
  'توقع', 'وقعت', 'يوقع', 'توقيع', 'تبحث', 'يبحث', 'تستعرض',
  'مشروع', 'المشروع', 'مشروعات', 'المشروعات', 'برنامج', 'البرنامج',
  'الرقمي', 'الرقمية', 'التحول', 'الذكية', 'الذكي', 'التكنولوجيا', 'التكنولوجية',
  'تطوير', 'لتطوير', 'تعزيز', 'لتعزيز', 'دعم', 'خدماتها', 'الخدمات',
  'جديد', 'الجديد', 'جديدة', 'الجديدة', 'أكبر', 'اكبر', 'الأولى', 'الأول',
  'قيمة', 'مليارات', 'جنيه', 'العام', 'اليوم', 'عبر', 'تحت', 'كيف',
]);

const narrTokens = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, ' ').split(/\s+/)
  .filter((w) => w.length >= 3 && !NARR_STOP.has(w));
// Distinctive tokens — long enough + non-brand + non-generic — are what make two
// stories "the same theme" even when their overall wording barely overlaps.
// Numbers are never a theme. "35 مليار" and "125 مليار" and "2026" bridged
// Vodafone's Q2 revenue to e&'s H1 revenue — two companies' results reported in
// the same units are not one story.
const isNumeric = (w) => /^[0-9٠-٩]+$/.test(w);
const strongToks = (s) => new Set([...narrTokens(s)].filter((w) => w.length >= 4 && !isNumeric(w) && !NARR_BRAND.has(w) && !NARR_GENERIC.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const sharedCount = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i; };

// Catch-all categories carry no theme information of their own, so two stories
// there must share MORE distinctive tokens to count as one narrative — generic
// business pairs ("stake sale", "strategic partnership") glued different
// companies' corporate stories together. Focused categories (pricing, network,
// vodafone_cash…) already narrow the theme, so 2 shared tokens stay enough.
const NARR_CATCHALL = new Set(['corporate', 'other', 'competitor']);

// ── stage 1: deterministic pre-pass ──
function preCluster(items, { threshold = 0.22 } = {}) {
  const clusters = [];
  for (const it of items) {
    const toks = new Set([...narrTokens(it.headline), ...narrTokens(it.summary)]);
    if (!toks.size) continue;
    const strong = strongToks(`${it.headline} ${it.summary}`);
    const cat = it.category || 'other';
    const brand = brandOf(it);
    // Join the best cluster where the item matches SOME MEMBER pairwise — never
    // the cluster's pooled tokens. Pooling snowballed: every join grew the pool,
    // so a big cluster eventually matched anything in its category. Pairwise
    // keeps a chain honest: each link must resemble an actual story.
    let best = null, bestScore = 0;
    for (const c of clusters) {
      let score = 0, qualifies = false;
      for (const m of c.members) {
        // A DIFFERENT category, or a different named brand, is evidence these are
        // separate threads — so demand more distinctive overlap rather than
        // refusing outright. Same real story does get filed under two categories
        // by the classifier (the stadium deal landed in both campaign and
        // corporate), and that split is exactly what used to fragment a thread
        // into four rows; but "different brand AND different category" is nearly
        // always two stories that merely share PR vocabulary.
        let need = NARR_CATCHALL.has(cat) ? 3 : 2;
        if (m.category !== cat) need += 1;
        // Two DIFFERENT named brands is the strongest signal of two stories:
        // rival press releases share vocabulary constantly (both run a "She
        // Leads" programme, both report quarterly revenue in billions). Only a
        // genuinely shared event — a market price rise, one buying the other's
        // stake — should clear this.
        if (m.brand !== brand && m.brand !== 'Market' && brand !== 'Market') need += 2;
        const j = jaccard(m.toks, toks);
        const sh = sharedCount(m.strong, strong);
        // Jaccard alone may not carry a cross-category or cross-brand join —
        // it measures overall wording, which press releases share by default.
        const looseOk = m.category === cat && m.brand === brand;
        if ((looseOk && j >= threshold) || sh >= need) qualifies = true;
        const s = Math.max(looseOk ? j : 0, sh >= need ? 0.2 + 0.02 * sh : 0);
        if (s > score) score = s;
      }
      if (qualifies && score > bestScore) { bestScore = score; best = c; }
    }
    const member = { toks, strong, category: cat, brand, item: it };
    if (best) { best.items.push(it); best.members.push(member); }
    else clusters.push({ category: cat, members: [member], items: [it] });
  }
  return clusters;
}

// ── naming (deterministic fallback) ──
// The most frequent CONTIGUOUS phrase across the cluster's headlines, not a bag
// of its most frequent tokens. A bag reads as keyword salad and, in Arabic,
// scrambles word order into nonsense ("الأهلي الشراكة استاد"). A phrase that
// actually occurs in the coverage reads as a title ("استاد الأهلي").
function phraseName(clusterItems) {
  const seqs = clusterItems.map((it) => narrTokens(it.headline).filter((w) => !NARR_BRAND.has(w)));
  const counts = new Map();
  seqs.forEach((seq, si) => {
    const seen = new Set();
    for (let n = 5; n >= 2; n--) {
      for (let i = 0; i + n <= seq.length; i++) {
        const gram = seq.slice(i, i + n);
        // A phrase made only of filler is not a title.
        if (gram.every((w) => NARR_GENERIC.has(w))) continue;
        const key = gram.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = counts.get(key) || { docs: 0, n, last: -1 };
        if (rec.last !== si) { rec.docs++; rec.last = si; }
        counts.set(key, rec);
      }
    }
  });
  const ranked = [...counts.entries()]
    .filter(([, r]) => r.docs >= 2)
    .sort((a, b) => (b[1].docs - a[1].docs) || (b[1].n - a[1].n) || a[0].localeCompare(b[0]));
  if (ranked.length) {
    // Prefer the longest phrase among those within one document of the best —
    // "أسعار باقات الإنترنت الأرضي" beats the shorter "أسعار باقات" it contains.
    const top = ranked[0][1].docs;
    const best = ranked.filter(([, r]) => r.docs >= top - 1).sort((a, b) => b[1].n - a[1].n)[0];
    return best[0];
  }
  // No shared phrase: fall back to the biggest story's headline, cut at its
  // first punctuation break so we get the actual clause and not a fragment
  // ending mid-quote.
  const rep = clusterItems.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))[0];
  const head = String(rep && rep.headline || '').split(/[:：.．\u2026]|\.\.|\s[-–—]\s/)[0];
  return head.replace(/["'«»“”]/g, '').trim().split(/\s+/).slice(0, 7).join(' ');
}

// ── stage 2: the LLM pass ──
const SYSTEM = `You group Egyptian telecom news stories into NARRATIVES for a PR team's trends dashboard.

A narrative is ONE running real-world story thread — the same event, deal, incident or campaign, covered by many outlets and followed over several days. Examples of a single narrative: a sponsorship deal plus the ceremony, the quotes from both sides, and the follow-up analysis. Examples of SEPARATE narratives that look similar: two different partnerships announced by the same company; a company's quarterly results vs its new product; an advertising campaign vs a plagiarism accusation about that campaign's music.

Rules:
- Group ONLY stories about the same underlying event or thread. When in doubt, keep them apart — a wrong merge is far worse than a missed one, because the dashboard then reports one number for two unrelated things.
- Stories about DIFFERENT brands are almost never one narrative. The exception is a genuine shared event (a market-wide price rise, one company buying another's stake).
- Ignore how the stories are categorised or worded. Judge the underlying event.
- A narrative needs at least 2 stories. Leave anything that has no partner OUT — do not invent groups to place every item.
- title: a specific, plain-English noun phrase of 3-7 words naming the event, in English even when the coverage is Arabic. Name the actual thing ("Al-Ahly stadium naming rights deal", "Public Prosecution services on Ana Vodafone", "Fixed-line internet price increases"). Never a generic label ("Corporate news", "Partnership"), never a brand name alone, never a verb phrase.

Return ONLY a JSON array, no prose or markdown fences:
[{"title": "...", "ids": [12, 34, 56]}, ...]
Every id must be one of the ids given to you. Never invent an id, never place an id in two narratives.`;

async function aiGroup(items, signalKey) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const lines = items.map((it) => {
    const sum = String(it.summary || '').slice(0, 180);
    return `${it.id} | ${brandOf(it)} | ${String(it.headline || '').slice(0, 160)}${sum ? `\n   ${sum}` : ''}`;
  }).join('\n');

  // /api/stats is an interactive page load, so this call gets a hard ceiling:
  // a hung API connection must cost the user a few seconds and the token
  // grouping, never a spinning Trends page.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: ctl.signal,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: `Group these ${items.length} stories.\n\n${lines}` }],
      }),
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  const data = await res.json();
  recordUsage('narrative', MODEL, data);   // fire-and-forget spend gauge; never awaited
  const text = (data && Array.isArray(data.content) ? data.content : [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s === -1 || e <= s) throw new Error('no JSON array in narrative grouping');
    parsed = JSON.parse(text.slice(s, e + 1));
  }
  if (!Array.isArray(parsed)) return null;

  // Trust nothing: every id must exist and may be used once. An id the model
  // dropped simply stays unclustered, which is the pre-AI behaviour for most
  // items anyway — far better than showing a card that isn't in the group.
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set();
  const groups = [];
  for (const g of parsed) {
    if (!g || !Array.isArray(g.ids)) continue;
    const members = [];
    for (const raw of g.ids) {
      const id = Number(raw);
      if (!byId.has(id) || used.has(id)) continue;
      used.add(id);
      members.push(byId.get(id));
    }
    const title = String(g.title || '').trim().replace(/\s+/g, ' ').slice(0, 90);
    if (members.length >= 2 && title) groups.push({ title, items: members });
  }
  if (!groups.length) return null;
  console.log(`narratives: AI grouped ${used.size}/${items.length} items into ${groups.length} threads (${signalKey})`);
  return groups;
}

// Memoise per (window, exact id set). /api/stats is an interactive page load and
// the same window gets re-requested constantly; the grouping only changes when
// the item set does, so the key IS the id set. Module scope, so a warm lambda
// reuses it — the same persistence that bites elsewhere (see CLAUDE.md) is the
// point here. Bounded so a long-lived instance can't grow without limit.
const aiCache = new Map();
const AI_CACHE_MAX = 12;
function cacheKey(days, items) {
  const ids = items.map((i) => i.id).filter(Boolean).sort((a, b) => a - b);
  let h = 0;
  for (const id of ids) h = (Math.imul(h, 31) + id) | 0;
  return `${days}:${ids.length}:${h}`;
}
export function _resetNarrativeCache() { aiCache.clear(); }

// ── orchestration ──
/**
 * Cluster relevant items into named narratives with a per-day volume series,
 * sentiment split and a "rising" flag. Async because of the LLM pass; never
 * throws on its account — a failure degrades to the deterministic grouping.
 *
 * `limit` is a DISPLAY cap, not a clustering one: a busy 30-day window produces
 * more than a dozen real threads, and at 12 genuine narratives were falling off
 * the list entirely (the umlaut "Best In Test" pair, 2026-07-31). Sorted rising
 * first, then by size, so what is cut is always the smallest and quietest.
 */
export async function buildNarratives(items, days, dayIdx, { minStories = 2, threshold = 0.22, limit = 20, ai = true } = {}) {
  const pre = preCluster(items, { threshold });
  // Only items that already have a partner are worth an LLM opinion; a lone
  // story cannot form a narrative, and dropping them keeps the prompt small.
  let groups = pre.filter((c) => c.items.length >= minStories)
    .map((c) => ({ title: null, items: c.items, category: c.category }));

  if (ai) {
    const candidates = pre.filter((c) => c.items.length >= minStories).flatMap((c) => c.items);
    const key = cacheKey(days.length, candidates);
    try {
      if (aiCache.has(key)) {
        groups = aiCache.get(key).map((g) => ({ ...g, items: g.items.slice() }));
      } else if (candidates.length >= minStories) {
        const aiGroups = await aiGroup(candidates, key);
        if (aiGroups) {
          groups = aiGroups;
          if (aiCache.size >= AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);
          aiCache.set(key, aiGroups);
        }
      }
    } catch (e) {
      console.error('narratives: AI grouping failed, keeping token clustering —', e.message);
    }
  }

  const zeros = () => days.map(() => 0);
  const out = [];
  for (const g of groups) {
    const cItems = g.items;
    if (cItems.length < minStories) continue;
    const series = zeros();
    let negative = 0, neutral = 0, positive = 0;
    const brandCount = {};
    const catCount = {};
    for (const it of cItems) {
      const idx = dayIdx.get(dayOfFn(it));
      if (idx !== undefined) series[idx]++;
      const s = sentOf(it);
      if (s === 'negative') negative++; else if (s === 'positive') positive++; else neutral++;
      const b = brandOf(it);
      brandCount[b] = (brandCount[b] || 0) + 1;
      const cat = it.category || 'other';
      catCount[cat] = (catCount[cat] || 0) + 1;
    }
    const brand = Object.entries(brandCount).sort((a, b) => b[1] - a[1])[0][0];
    const category = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0][0];
    const rep = cItems.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))[0];
    // An AI title already names the event, so it stands alone; a fallback name
    // is a bare phrase and needs the brand prefix to be readable.
    const name = g.title || ((brand === 'Market' ? '' : `${brand} · `) + phraseName(cItems));

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
      name, brand, category, total: cItems.length,
      negative, neutral, positive, series, rising, risingScore,
      headline: rep.headline || null,
      // The board opens a narrative by fetching THESE ids, so a short list is a
      // silently wrong board: a 27-story narrative shipped 20 ids and showed 20
      // cards, dropping its only negative (live-reported 2026-07-31). Ordered by
      // importance so a cluster past the cap keeps its biggest stories, and
      // idsTotal lets the board say when it is showing a subset.
      ids: cItems.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map((i) => i.id).filter(Boolean).slice(0, NARR_IDS_MAX),
      idsTotal: cItems.filter((i) => i.id).length,
    });
  }
  return out
    .sort((a, b) => (Number(b.rising) - Number(a.rising)) || (b.risingScore - a.risingScore) || (b.total - a.total))
    .slice(0, limit);
}

// Cairo-day bucketing must match api/stats.js exactly — the series indexes into
// the same day axis the charts draw.
const cairoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
function dayOfFn(it) {
  const t = it.published_at || it.seen_at;
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : cairoDay.format(d);
}
