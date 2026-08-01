// Shared lexical dedupe primitives.
//
// These live here, not in api/radar.js, because two callers need the SAME
// notion of "these are the same story": the ingest pipeline (which merges
// duplicates as they arrive) and the admin duplicate-finder (which looks for
// pairs that slipped through and are sitting on the board as two cards). One
// implementation, one answer.

// Second dedupe layer: exact-hash catches "same headline reposted", but
// different publishers rewrite the same story with different words. Group
// by significant-token overlap (Jaccard) within the same country so we
// don't collapse different stories that happen to share vocabulary.
export const STOPWORDS = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were','be','been',
  'by','with','from','as','that','this','these','those','says','said','have','has','had','will','can',
  'may','might','after','before','over','under','into','about','more','than','their','they','them',
  'new','news','report','reports','update','updates','latest','announces','announced','launches',
  'launched','opens','opened','plans','plan',
  // Brand + geo + generic-sector tokens: every story about a brand shares these,
  // so counting them as similarity gives two unrelated same-brand stories a floor
  // they didn't earn — how a distinct story or a next-day development gets wrongly
  // merged and hidden. Excluding them lets only DISTINCTIVE words drive the merge.
  'vodafone','orange','etisalat','telecom','egypt','egyptian','cash','mobile','money',
  'فودافون','اورنج','أورنج','اتصالات','المصرية',
]);
export function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\w\s\u0600-\u06ff]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
  );
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Candidate duplicate PAIRS among already-stored cards — the ones the ingest
 * passes let through. Deliberately looser than ingest: ingest must not merge
 * wrongly without a human, so it only acts above 0.5/0.55 (or when the semantic
 * model confirms). This returns everything from `min` up, for a person to judge.
 *
 * Only pairs published within `windowDays` of each other are considered, the
 * same span the pipeline compares over — two price-list stories a month apart
 * are a recurring genre, not a duplicate.
 */
export function findDuplicateCandidates(items, { min = 0.3, windowDays = 5, limit = 120 } = {}) {
  const rows = (items || []).filter((i) => i && i.headline);
  const prepped = rows.map((i) => ({
    item: i,
    head: tokenize(i.headline),
    summ: tokenize(i.summary),
    t: new Date(i.published_at || i.seen_at || 0).getTime(),
  }));
  const out = [];
  for (let a = 0; a < prepped.length; a++) {
    for (let b = a + 1; b < prepped.length; b++) {
      const x = prepped[a], y = prepped[b];
      if (Math.abs(x.t - y.t) > windowDays * 864e5) continue;
      const headScore = jaccard(x.head, y.head);
      const summScore = jaccard(x.summ, y.summ);
      const score = Math.max(headScore, summScore);
      if (score < min) continue;
      // Keep the older card: that is the one the pipeline would have merged
      // into, and the one whose id the board has already linked to.
      const [keep, drop] = x.t <= y.t ? [x.item, y.item] : [y.item, x.item];
      out.push({
        score: Math.round(score * 100) / 100,
        headScore: Math.round(headScore * 100) / 100,
        summScore: Math.round(summScore * 100) / 100,
        // Above the ingest bars this pair should never have survived; below
        // them it is the semantic backstop's territory. Worth telling apart.
        band: (headScore >= 0.55 || summScore >= 0.5) ? 'lexical' : 'semantic',
        keep: { id: keep.id, headline: keep.headline, summary: keep.summary, source: keep.source, brand: keep.brand, published_at: keep.published_at },
        drop: { id: drop.id, headline: drop.headline, summary: drop.summary, source: drop.source, brand: drop.brand, published_at: drop.published_at },
      });
    }
  }
  return out.sort((p, q) => q.score - p.score).slice(0, limit);
}
