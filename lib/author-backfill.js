// Shared author backfill. Fills stored, still-authorless board items via the
// RSS-byline → resolve → fetch → cascade+AI hop, and writes each byline back.
// Used by the daily run (api/radar.js) and the admin "Backfill authors" action
// (api/admin.js) — identical logic, one place. pr_* only; read-mostly (the only
// writes are author + resolved_url onto already-stored rows); never throws.

import { itemsMissingAuthor, setItemAuthor, instancesForItems } from './db.js';
import { fetchAuthor, cleanAuthor } from './author.js';
import { resolveUrl, isGoogleNews } from './resolve.js';

/** Fill authors for a set of authorless items. Returns the count filled. */
export async function fillMissingAuthors(stale) {
  if (!stale || !stale.length) return 0;
  const instMap = await instancesForItems(stale.map((i) => i.id).filter(Boolean)).catch(() => ({}));
  const filled = await Promise.all(stale.map(async (it) => {
    const insts = instMap[it.id] || [];
    // An RSS byline on any instance wins — no fetch needed.
    let author = null;
    for (const x of insts) { author = cleanAuthor(x.author, x.outlet); if (author) break; }
    // Resolve the primary URL (Google-News wrapper → real publisher link).
    let resolved = it.resolved_url || null;
    if (!resolved) {
      const primaryUrl = (insts[0] && insts[0].url) || it.url;
      try { const r = await resolveUrl(primaryUrl); if (r && !isGoogleNews(r)) resolved = r; } catch { /* keep null */ }
    }
    // Otherwise fetch the candidate URLs and extract (cascade + AI fallback).
    if (!author) {
      const urls = [...new Set([resolved, it.url, ...insts.map((x) => x.url)].filter((u) => u && !isGoogleNews(u)))];
      for (const u of urls) {
        const person = cleanAuthor(await fetchAuthor(u), (insts[0] && insts[0].outlet) || it.source);
        if (person) { author = person; break; }
      }
    }
    if (!author) return false;
    try { await setItemAuthor(it.id, author, resolved && resolved !== it.resolved_url ? resolved : null); return true; }
    catch (e) { console.error('author backfill write failed', it.id, e.message); return false; }
  }));
  return filled.filter(Boolean).length;
}

/** One bounded sweep: find authorless items, fill them, report how many remain.
    ?days (1..30, default 3), ?limit (1..200, default 40), highest-importance
    first. Returns { days, limit, scanned, filled, remaining }. */
export async function sweepAuthors({ days = 3, limit = 40 } = {}) {
  const d = Math.max(1, Math.min(Number(days) || 3, 30));
  const lim = Math.max(1, Math.min(Number(limit) || 40, 200));
  const stale = await itemsMissingAuthor({ days: d, limit: lim });
  const filled = await fillMissingAuthors(stale);
  let remaining = null;
  try { remaining = (await itemsMissingAuthor({ days: d, limit: 200 }) || []).length; } catch { /* best-effort */ }
  return { days: d, limit: lim, scanned: (stale || []).length, filled, remaining };
}
