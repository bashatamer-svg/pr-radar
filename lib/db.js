// Thin PostgREST client. Avoids the supabase-js dependency so the build
// can't break on an SDK bump you didn't ask for.
//
// SHARED-PROJECT SAFETY: every table this file touches is `pr_*`. It NEVER
// reads or writes a `radar_*` table, so pointing SUPABASE_URL at the Regulatory
// Radar's project cannot affect the regulatory data.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = (extra = {}) => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function rest(path, opts = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers) });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Return the subset of `hashes` already present in pr_items. */
export async function existingHashes(hashes) {
  const found = new Set();
  for (let i = 0; i < hashes.length; i += 100) {
    const chunk = hashes.slice(i, i + 100);
    const rows = await rest(`pr_items?select=hash&hash=in.(${chunk.join(',')})`);
    rows.forEach((r) => found.add(r.hash));
  }
  return found;
}

/** Same idea, but against the summary_hash column — catches items already in the
    DB that we're seeing under a different headline (e.g. an Arabic and an
    English publisher running the same story). */
export async function existingSummaryHashes(hashes) {
  const found = new Set();
  const list = hashes.filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const rows = await rest(`pr_items?select=summary_hash&summary_hash=in.(${chunk.join(',')})`);
    rows.forEach((r) => r.summary_hash && found.add(r.summary_hash));
  }
  return found;
}

/** Recent stored stories (relevant or not) for cross-run fuzzy dedup. The hash
    checks only catch an EXACT repost; a publisher rewording a story we stored
    earlier — or an Arabic/English pair — gets a different hash and slips through
    as a duplicate card. Callers compare candidate headline AND summary tokens
    against these. Window is generous (default 5 days). Newest-first. */
export async function recentStories({ days = 5, limit = 2500 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_items?select=headline,summary,country` +
      `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
      `&order=seen_at.desc&limit=${limit}`
  );
}

/** The admin-editable living PR-knowledge doc, injected into every
    classification. Empty string if unset / on error (callers fail open). */
export async function getHouseKnowledge() {
  const rows = await rest(`pr_context?select=content&key=eq.house_knowledge`);
  return rows && rows.length ? (rows[0].content || '') : '';
}
/** When the living-knowledge doc was last edited (ISO string) or null. */
export async function houseKnowledgeUpdatedAt() {
  const rows = await rest(`pr_context?select=updated_at&key=eq.house_knowledge`);
  return rows && rows.length ? rows[0].updated_at : null;
}
/** Upsert the living PR-knowledge doc (edited from a context page). */
export async function setHouseKnowledge(content) {
  return rest('pr_context', {
    method: 'POST',
    body: JSON.stringify({ key: 'house_knowledge', content: String(content ?? ''), updated_at: new Date().toISOString() }),
    headers: { Prefer: 'resolution=merge-duplicates' },
  });
}

/** Epoch-ms of the last time `key` was touched, or 0 if never / on error.
    Backs the daily-bulletin idempotency guard. */
export async function getStateTime(key) {
  const rows = await rest(`pr_state?select=updated_at&key=eq.${encodeURIComponent(key)}`);
  return rows && rows.length ? new Date(rows[0].updated_at).getTime() : 0;
}

/** Upsert `key`'s timestamp to now (merge-duplicates: one row per key). */
export async function touchState(key) {
  await rest('pr_state', {
    method: 'POST',
    body: JSON.stringify({ key, updated_at: new Date().toISOString() }),
    headers: { Prefer: 'resolution=merge-duplicates' },
  });
}

export async function insertItems(rows) {
  if (!rows.length) return [];
  return rest('pr_items', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
  });
}

/** Write coverage instances (one per outlet that ran a story). ignore-duplicates
    so a re-run doesn't error on the (item_id,url) unique key. */
export async function insertInstances(rows) {
  if (!rows.length) return [];
  return rest('pr_instances', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
  });
}

/** All instances for a set of item ids, grouped by item_id, for the board/email
    render ("also published in …"). */
export async function instancesForItems(ids) {
  if (!ids.length) return {};
  const inList = ids.join(',');
  const rows = await rest(
    `pr_instances?item_id=in.(${inList})&select=item_id,outlet,author,url,published_at&order=published_at.asc`
  );
  const byItem = {};
  for (const r of rows || []) (byItem[r.item_id] ||= []).push(r);
  return byItem;
}

export async function recordFeedHealth(feedId, ok, error) {
  await rest('pr_feed_health', {
    method: 'POST',
    body: JSON.stringify({
      feed_id: feedId,
      last_ok_at: ok ? new Date().toISOString() : undefined,
      last_error: ok ? null : String(error).slice(0, 300),
      fail_streak: ok ? 0 : 1,
    }),
    headers: { Prefer: 'resolution=merge-duplicates' },
  });
}

export async function brokenFeeds() {
  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString();
  return rest(`pr_feed_health?select=feed_id,last_error&or=(last_ok_at.is.null,last_ok_at.lt.${cutoff})`);
}

/** Active watchlist subscribers. NULL/empty categories = "everything". */
export async function activeSubscribers() {
  return rest(`pr_subscribers?select=email,name,categories&active=is.true&order=id.asc`);
}

/** Specific items by id, any age — backs the board's "Saved" filter, whose
    starred items can be older than the current window. */
export async function itemsByIds(ids) {
  const clean = (ids || []).map((n) => parseInt(n, 10)).filter(Number.isInteger).slice(0, 100);
  if (!clean.length) return [];
  return rest(
    `pr_items?select=*&id=in.(${clean.join(',')})` +
      `&order=importance.desc,published_at.desc.nullslast,seen_at.desc`
  );
}

/** Minimal row backing the /api/go share-redirect: the Google News wrapper
    (url) plus any real publisher URL we've already decoded (resolved_url).
    Returns null when the id doesn't exist. */
export async function itemLink(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  const rows = await rest(`pr_items?select=id,url,resolved_url&id=eq.${n}&limit=1`);
  return rows && rows.length ? rows[0] : null;
}

/** Cache the decoded publisher URL so the next share of the same item skips
    resolution. Best-effort: callers swallow errors. */
export async function setResolvedUrl(id, url) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || !url) return;
  await rest(`pr_items?id=eq.${n}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved_url: String(url).slice(0, 2000) }),
    headers: { Prefer: 'return=minimal' },
  });
}

/** Minimal columns for the /stats aggregation, over the SAME window predicate
    as recentItems so the stats numbers reconcile with the board. Paginated —
    Supabase caps a single response at 1000 rows, and a 90-day window can
    exceed that; an unpaged fetch would silently truncate the trend. */
export async function itemsForStats({ days = 30, withText = false } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // headline+summary are only needed by the /stats narrative clustering; surge
  // + report callers omit them (withText:false) to keep their fetch lean.
  const cols = `id,brand,sentiment,category,importance,author,source,published_at,seen_at${withText ? ',headline,summary' : ''}`;
  const out = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 10000; offset += PAGE) {
    const rows = await rest(
      `pr_items?select=${cols}` +
        `&is_relevant=is.true` +
        `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
        `&order=id.asc&limit=${PAGE}&offset=${offset}`
    );
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
  }
  return out;
}

/** Last N days of relevant items for the board + the daily digest. Ordered by
    severity then recency (no tier — this app is Egypt-only). Items without a
    published_at fall back to seen_at so nothing silently disappears. */
export async function recentItems({ days = 7, limit = 200 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_items?select=*&is_relevant=is.true` +
      `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
      `&order=importance.desc,published_at.desc.nullslast,seen_at.desc&limit=${limit}`
  );
}
