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

/** Map of hash -> stored item id, for every `hashes` entry already in pr_items.
    A Map rather than a Set because a cross-run repost must be MERGED into the
    card it repeats — the caller needs the id to attach the new outlet as a
    coverage instance. `.has()` reads exactly as before for callers that only
    ask "seen this?". */
export async function existingHashes(hashes) {
  const found = new Map();
  for (let i = 0; i < hashes.length; i += 100) {
    const chunk = hashes.slice(i, i + 100);
    const rows = await rest(`pr_items?select=id,hash&hash=in.(${chunk.join(',')})`);
    rows.forEach((r) => found.set(r.hash, r.id));
  }
  return found;
}

/** Same idea, but against the summary_hash column — catches items already in the
    DB that we're seeing under a different headline (e.g. an Arabic and an
    English publisher running the same story). */
export async function existingSummaryHashes(hashes) {
  const found = new Map();
  const list = hashes.filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const rows = await rest(`pr_items?select=id,summary_hash&summary_hash=in.(${chunk.join(',')})`);
    rows.forEach((r) => r.summary_hash && found.set(r.summary_hash, r.id));
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
    `pr_items?select=id,headline,summary,country` +
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
  // Same (item_id,url) twice INSIDE one payload conflicts just as hard as one
  // already stored, and Postgres rejects the whole statement either way.
  const seen = new Set();
  const clean = rows.filter((r) => {
    const k = `${r.item_id}|${r.url || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!clean.length) return [];
  // on_conflict names the UNIQUE constraint to resolve against. Without it
  // `resolution=ignore-duplicates` is inert on a non-primary-key constraint,
  // so a single already-stored row 409s and takes the ENTIRE batch with it —
  // silently losing every genuinely new outlet in the same run. That is exactly
  // what production did on every poll once cross-run merges started re-offering
  // the same repost (caught in the runtime logs, 2026-08-01).
  return rest('pr_instances?on_conflict=item_id,url', {
    method: 'POST',
    body: JSON.stringify(clean),
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
  return rest(`pr_subscribers?select=email,name,categories,whatsapp&active=is.true&order=id.asc`);
}

/** Digits-only WhatsApp numbers of ACTIVE subscribers who have one.
    `active` gates both channels: switching someone off stops the daily brief
    AND stops paging them, so there is one switch and no surprises. */
export async function whatsappSubscribers() {
  const rows = await rest(`pr_subscribers?select=whatsapp&active=is.true&whatsapp=not.is.null&order=id.asc`);
  return (rows || []).map((r) => String(r.whatsapp || '').replace(/[^\d]/g, '')).filter((n) => n.length >= 8);
}

/* ── subscriber + feedback admin (backs /admin.html) ── */

/** All subscribers (active first) for the admin list. */
export async function allSubscribers() {
  return rest(`pr_subscribers?select=id,email,name,categories,whatsapp,active,created_at&order=active.desc,id.asc`);
}

/** Add (or re-activate/update) a subscriber. Upsert on the unique email so
    re-adding a removed address just flips it back on. */
export async function addSubscriber({ email, name, categories, whatsapp }) {
  // NULL, never '' — the same convention as pr_items.author, so "no WhatsApp"
  // is unambiguous rather than an empty string that reads as a value.
  const wa = String(whatsapp || '').replace(/[^\d]/g, '');
  return rest('pr_subscribers', {
    method: 'POST',
    body: JSON.stringify({
      email: String(email).trim().toLowerCase(),
      name: name ? String(name).trim() : null,
      categories: Array.isArray(categories) && categories.length ? categories : null,
      whatsapp: wa.length >= 8 ? wa : null,
      active: true,
    }),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
}

/** Toggle a subscriber's active flag (soft on/off without losing their row). */
export async function setSubscriberActive(id, active) {
  return rest(`pr_subscribers?id=eq.${Number(id)}`, {
    method: 'PATCH', body: JSON.stringify({ active: !!active }), headers: { Prefer: 'return=minimal' },
  });
}

/** Hard-delete a subscriber. */
export async function removeSubscriber(id) {
  return rest(`pr_subscribers?id=eq.${Number(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

/** All board feedback, open (unresolved) first, newest first. */
export async function allFeedback({ limit = 200 } = {}) {
  return rest(`pr_feedback?select=*&order=resolved.asc,created_at.desc&limit=${Math.min(limit, 500)}`);
}

/** Mark a feedback row resolved / re-open it. */
export async function setFeedbackResolved(id, resolved) {
  return rest(`pr_feedback?id=eq.${Number(id)}`, {
    method: 'PATCH', body: JSON.stringify({ resolved: !!resolved }), headers: { Prefer: 'return=minimal' },
  });
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

/** How earlier runs classified a set of story hashes — backs the ?debug=1
    coverage trace's "already stored" dispositions, so 'stored' can be split into
    'on the board' vs 'stored as not-relevant' (the silent-gap case). Read-only. */
export async function itemsByHashes(hashes) {
  const list = (hashes || []).filter(Boolean).slice(0, 300);
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    out.push(...((await rest(
      `pr_items?select=hash,headline,is_relevant,importance,sentiment,brand&hash=in.(${chunk.join(',')})`
    )) || []));
  }
  return out;
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

/** All RELEVANT items in an explicit [fromIso, toIso) window — backs the custom
    date-range report. Same predicate family as the board/stats (is_relevant,
    published_at falling back to seen_at) so the numbers reconcile. Paginated to
    a 4000-row ceiling (a 92-day report window), read-only.
    cols 'lean' → aggregate columns only; 'full' → everything the coverage-log
    appendix and highlight cards need. */
export async function itemsBetween({ fromIso, toIso, cols = 'lean' } = {}) {
  const select = cols === 'full'
    ? 'id,brand,sentiment,category,importance,author,source,headline,summary,pr_angle,url,resolved_url,published_at,seen_at,team_share,feedback'
    : 'id,brand,sentiment,category,importance,published_at,seen_at';
  const win = `&or=(and(published_at.gte.${fromIso},published_at.lt.${toIso}),` +
              `and(published_at.is.null,seen_at.gte.${fromIso},seen_at.lt.${toIso}))`;
  const out = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 4000; offset += PAGE) {
    const rows = await rest(
      `pr_items?select=${select}&is_relevant=is.true${win}` +
        `&order=id.asc&limit=${PAGE}&offset=${offset}`
    );
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
  }
  if (out.length >= 4000) console.warn(`itemsBetween: hit the 4000-row ceiling for ${fromIso}..${toIso} — report truncated`);
  return out;
}

/** Recent RELEVANT board items still missing an author. The 15-min urgent poll
    ingests brand stories but skips author extraction (speed), and the daily run
    then dedups them out — so those items keep "—" forever. This backs the daily
    stored-author backfill: highest-importance first, capped. Read-only. */
export async function itemsMissingAuthor({ days = 2, limit = 20 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_items?select=id,url,resolved_url,source,importance,headline` +
      `&is_relevant=is.true&author=is.null` +
      `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
      `&order=importance.desc,published_at.desc.nullslast,seen_at.desc&limit=${limit}`
  );
}

/** Exact count of recent RELEVANT board items still missing an author — backs the
    admin "N still missing" backlog indicator. One lightweight query: count=exact
    returns the total in the Content-Range header while Range 0-0 fetches no rows. */
export async function countMissingAuthor({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const path = `pr_items?select=id&is_relevant=is.true&author=is.null` +
    `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))`;
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: headers({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const total = (res.headers.get('content-range') || '').split('/')[1];   // "0-0/137" or "*/0"
  return total && total !== '*' ? (Number(total) || 0) : 0;
}

/** Write a resolved author (and optionally the decoded publisher URL) onto one
    stored item. Only ever SETS an author — callers pass one they extracted, so
    this never clears a real byline. Best-effort. */
export async function setItemAuthor(id, author, resolvedUrl) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || !author) return;
  const patch = { author: String(author).slice(0, 120) };
  if (resolvedUrl) patch.resolved_url = String(resolvedUrl).slice(0, 2000);
  await rest(`pr_items?id=eq.${n}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
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
  // The loop stops at offset 10000. If we filled every page the window is
  // larger than we fetched, so the stats/narrative aggregates silently omit the
  // oldest items — surface that instead of quietly under-counting.
  if (out.length >= 10000) {
    console.warn(`itemsForStats: hit the 10000-row ceiling for the ${days}d window — stats truncated (oldest relevant items omitted)`);
  }
  return out;
}

/** Last N days of relevant items for the board + the daily digest. Ordered by
    severity then recency (no tier — this app is Egypt-only). Items without a
    published_at fall back to seen_at so nothing silently disappears. */
export async function recentItems({ days = 7, limit = 200 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = await rest(
    `pr_items?select=*&is_relevant=is.true` +
      `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
      `&order=importance.desc,published_at.desc.nullslast,seen_at.desc&limit=${limit}`
  );
  // A full page means the window was capped: lower-importance / older items
  // beyond the limit never reach the board or the digest. Say so.
  if (Array.isArray(rows) && rows.length === limit) {
    console.warn(`recentItems: board window capped at ${limit} rows for the ${days}d window — older/lower-importance items omitted`);
  }
  return rows;
}

/* ── RBAC users (pr_users) + audit log (pr_audit) — Task 16 ──────────────────
   pr_users is the closed allowlist: only emails here (or in ADMIN_EMAILS) may
   sign in. Everything is pr_* and never touches radar_*. */

/** The managed allowlist, admins first then newest. */
export async function listUsers() {
  return rest(`pr_users?select=id,email,role,name,active,invited_by,last_seen_at,created_at&order=role.asc,created_at.desc`);
}

/** Look up one user by (lowercased) email. Returns the row or null. */
export async function getUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const rows = await rest(`pr_users?select=id,email,role,active&email=eq.${encodeURIComponent(e)}&limit=1`);
  return (rows && rows[0]) || null;
}

/** Add or update an allowlist entry. Upsert on the unique email so re-adding a
    removed person flips them back on. */
export async function upsertUser({ email, role = 'viewer', name, invited_by }) {
  return rest('pr_users', {
    method: 'POST',
    body: JSON.stringify({
      email: String(email).trim().toLowerCase(),
      role: role === 'admin' ? 'admin' : 'viewer',
      name: name ? String(name).trim() : null,
      invited_by: invited_by ? String(invited_by) : null,
      active: true,
    }),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
}

/** Change a user's role. */
export async function setUserRole(id, role) {
  return rest(`pr_users?id=eq.${Number(id)}`, {
    method: 'PATCH', body: JSON.stringify({ role: role === 'admin' ? 'admin' : 'viewer' }), headers: { Prefer: 'return=minimal' },
  });
}

/** Toggle a user active/inactive — an inactive user is blocked on next request. */
export async function setUserActive(id, active) {
  return rest(`pr_users?id=eq.${Number(id)}`, {
    method: 'PATCH', body: JSON.stringify({ active: !!active }), headers: { Prefer: 'return=minimal' },
  });
}

/** Hard-delete an allowlist entry. */
export async function removeUser(id) {
  return rest(`pr_users?id=eq.${Number(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

/** Stamp last_seen_at for a user (fail-soft, best-effort). */
export async function touchUserSeen(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return;
  try {
    await rest(`pr_users?email=eq.${encodeURIComponent(e)}`, {
      method: 'PATCH', body: JSON.stringify({ last_seen_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' },
    });
  } catch (e2) { /* non-fatal */ }
}

/** Append one audit row. Fail-soft: auditing must never break the action. */
export async function addAudit({ actor, actor_role, action, target, detail, ip }) {
  try {
    await rest('pr_audit', {
      method: 'POST',
      body: JSON.stringify({
        actor: actor || null,
        actor_role: actor_role || null,
        action: String(action),
        target: target != null ? String(target) : null,
        detail: detail == null ? null : detail,
        ip: ip || null,
      }),
      headers: { Prefer: 'return=minimal' },
    });
  } catch (e) { console.error('audit write failed (non-fatal)', e.message); }
}

/** Recent audit entries, newest first. */
export async function recentAudit({ limit = 200 } = {}) {
  return rest(`pr_audit?select=*&order=created_at.desc&limit=${Math.min(Number(limit) || 200, 500)}`);
}

/** A person asks for access from the login screen. Creates a PENDING pr_users
    row (active=false, invited_by='request') that can't sign in until an admin
    approves it. No-op if they already have a row. Returns the status. */
export async function requestAccess(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { status: 'invalid' };
  const existing = await getUserByEmail(e).catch(() => null);
  if (existing) return { status: existing.active ? 'active' : 'pending' };
  await rest('pr_users', {
    method: 'POST',
    body: JSON.stringify({ email: e, role: 'viewer', active: false, invited_by: 'request' }),
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
  return { status: 'created' };
}

/** Pending access requests (self-requested, not yet approved), newest first. */
export async function pendingRequests() {
  return rest(`pr_users?select=id,email,name,created_at&active=is.false&invited_by=eq.request&order=created_at.desc`);
}

/** Count recent failed sign-ins for an email OR ip (brute-force throttle). */
export async function authFailuresSince({ email, ip, sinceIso }) {
  const conds = [];
  if (email) conds.push(`actor.eq.${encodeURIComponent(String(email).toLowerCase())}`);
  if (ip) conds.push(`ip.eq.${encodeURIComponent(ip)}`);
  if (!conds.length) return 0;
  const rows = await rest(
    `pr_audit?select=id&action=eq.auth.signin_failed&created_at=gte.${encodeURIComponent(sinceIso)}&or=(${conds.join(',')})&limit=100`
  );
  return (rows || []).length;
}

/** Relevant cards in the window, with the text the duplicate-finder compares.
    Board scope, so what it finds is what the user is actually looking at. */
export async function itemsForDupeScan({ days = 30, limit = 600 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_items?select=id,headline,summary,source,brand,published_at,seen_at` +
      `&is_relevant=is.true` +
      `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))` +
      `&order=published_at.asc&limit=${limit}`
  );
}

/** Fold `dropId` into `keepId`: every outlet that ran the duplicate becomes
    coverage on the card we keep, then the duplicate is hidden EVERYWHERE
    (is_relevant:false, not team_share) so it stops double-counting in Trends
    as well as leaving the board. Reversible: flip is_relevant back.
    Returns what actually moved, so the caller can report it honestly. */
export async function mergeDuplicateInto(keepId, dropId) {
  const keep = Number(keepId), drop = Number(dropId);
  if (!Number.isInteger(keep) || !Number.isInteger(drop) || keep === drop) {
    throw new Error('merge needs two different item ids');
  }
  const [dropRow] = (await rest(`pr_items?select=id,source,author,url,published_at&id=eq.${drop}`)) || [];
  if (!dropRow) throw new Error(`item ${drop} not found`);
  const [keepRow] = (await rest(`pr_items?select=id&id=eq.${keep}`)) || [];
  if (!keepRow) throw new Error(`item ${keep} not found`);

  const dropInsts = (await rest(`pr_instances?item_id=eq.${drop}&select=outlet,author,url,published_at`)) || [];
  const keepInsts = (await rest(`pr_instances?item_id=eq.${keep}&select=url`)) || [];
  const have = new Set(keepInsts.map((r) => r.url).filter(Boolean));

  // Its instances ARE its coverage: ingest writes one for the item's own source
  // at insert time, carrying the RESOLVED publisher link. The item's own `url`
  // is usually the same article's Google-News redirect, so adding both wrote the
  // one article twice and a card read "3 outlets" for a single outlet (seen
  // live 2026-08-01). Only fall back to the row itself when it has none.
  const candidates = dropInsts.length
    ? dropInsts
    : [{ outlet: dropRow.source, author: dropRow.author, url: dropRow.url, published_at: dropRow.published_at }];
  const rows = [];
  for (const c of candidates) {
    if (!c.url || have.has(c.url)) continue;   // (item_id,url) is unique
    have.add(c.url);
    rows.push({ item_id: keep, outlet: c.outlet || null, author: c.author || null, url: c.url, published_at: c.published_at || null });
  }
  if (rows.length) await insertInstances(rows);
  await rest(`pr_items?id=eq.${drop}`, {
    method: 'PATCH', body: JSON.stringify({ is_relevant: false }),
    headers: { Prefer: 'return=minimal' },
  });
  return { keep, drop, outletsMoved: rows.length };
}

/* ── health checks (backs /api/alerts + Admin → Health) ─────────────────────
   Every query here is fail-soft AT THE CALLER: /api/alerts wraps each in its
   own .catch() so one unavailable table degrades a single check to 'unknown'
   instead of blanking the page. Functions that need a table PR Radar hasn't
   migrated yet (pr_alerts, pr_usage) therefore THROW rather than returning an
   empty result — "not switched on" and "switched on and clear" must not look
   the same. */

/** Exact row count with no rows transferred: `count=exact` puts the total in
    the Content-Range header while Range 0-0 fetches nothing. Cheap enough to
    run a dozen of these on a page load, even against the whole item table. */
async function countRows(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: headers({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const total = (res.headers.get('content-range') || '').split('/')[1];   // "0-0/137" or "*/0"
  return total && total !== '*' ? (Number(total) || 0) : 0;
}

/** Append one alert. Best-effort: recording an alert must NEVER break the run
    that raised it, or swallow the email that matters more. Returns false when
    pr_alerts hasn't been migrated. */
export async function recordAlert({ kind, severity = 'warn', title, detail = '' }) {
  try {
    await rest('pr_alerts', {
      method: 'POST',
      body: JSON.stringify({
        kind: String(kind || 'ops').slice(0, 40),
        severity: String(severity).slice(0, 10),
        title: String(title || '').slice(0, 300),
        detail: String(detail || '').slice(0, 4000),
        created_at: new Date().toISOString(),
      }),
      headers: { Prefer: 'return=minimal' },
    });
    return true;
  } catch { return false; }   // table may not exist yet, or a transient blip
}

/** Recent alerts, newest first. THROWS when the table is absent so the caller
    can report the log as unavailable rather than as empty. */
export async function recentAlerts({ days = 14, limit = 100 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_alerts?select=kind,severity,title,detail,created_at` +
      `&created_at=gte.${since}&order=created_at.desc&limit=${limit}`
  );
}

/** When the pipeline last stored anything at all (ISO string, or null). */
export async function lastItemSeenAt() {
  const rows = await rest('pr_items?select=seen_at&order=seen_at.desc&limit=1');
  return rows && rows.length ? rows[0].seen_at : null;
}

/** How many items were stored / are relevant in the last `hours`. */
export async function ingestSummary({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 36e5).toISOString();
  const [stored, relevant] = await Promise.all([
    countRows(`pr_items?seen_at=gte.${since}`),
    countRows(`pr_items?is_relevant=is.true&seen_at=gte.${since}`),
  ]);
  return { stored, relevant };
}

/** Items the classifier returned NO verdict for — classify.js parks these as
    category:'unclassified' + confidence:0 + summary:null rather than guessing.
    They are invisible everywhere (is_relevant:false), so nothing else surfaces
    them: a run where the API was rate-limited or the account capped looks
    completely normal on the board. */
/** The parked rows themselves, for a re-run — SAME predicate as
    parkedItemCount, so what the Health check counts is exactly what the
    re-classify tool picks up. `snippet` was never stored, so a re-run screens
    on the headline alone; that is enough to clear off-topic wire copy, which
    is what parks in bulk. */
export function parkedItems({ days = 2, limit = 100 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return rest(
    `pr_items?select=id,hash,headline,url,source,author,published_at&category=eq.unclassified&confidence=eq.0&summary=is.null&seen_at=gte.${since}&order=seen_at.desc&limit=${limit}`
  );
}

/** Write a fresh verdict onto an existing card. Used by the re-classify tool;
    never touches hash/url/seen_at, so the card keeps its identity and coverage. */
export function updateItemVerdict(id, v) {
  return rest(`pr_items?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(v),
    headers: { Prefer: 'return=minimal' },
  });
}

export function parkedItemCount({ days = 2 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return countRows(
    `pr_items?category=eq.unclassified&confidence=eq.0&summary=is.null&seen_at=gte.${since}`
  );
}

/** How many stories in the last `hours` would go in the daily brief.
    api/radar.js builds the digest from the last 24h of relevant items at
    importance >= 2 — and sends NOTHING when that set is empty. So a stale
    "last sent" marker is only a fault if there was something to send; without
    this the bulletin check would sit at crit through every quiet week. */
export function digestEligibleCount({ hours = 24, minImportance = 2, until = null } = {}) {
  // `until` moves the window's END. The health check needs "how many would the
  // digest have carried AT the last scheduled run", not "how many are queued
  // right now" — a story that landed after the 05:00 cron was never available
  // to it, so counting it as evidence of a missed send is a false alarm.
  const end = until ? new Date(until).getTime() : Date.now();
  const since = new Date(end - hours * 36e5).toISOString();
  let q = `pr_items?is_relevant=is.true&importance=gte.${minImportance}&seen_at=gte.${since}`;
  if (until) q += `&seen_at=lt.${new Date(end).toISOString()}`;
  return countRows(q);
}

/** Relevance rate for the last 7 days against the 3 weeks before it.
 *
 *  Deliberately NOT the 24h-vs-same-weekday comparison the Regulatory Radar
 *  uses. PR Radar keeps 1-15 relevant stories a DAY out of 55-175 scanned
 *  (measured over 21 days to 2 Aug 2026): a single day's rate swings between
 *  0.0% and 11.9% on sampling noise alone, so a day-on-day test would cry wolf
 *  most mornings and mean nothing when it fired. Whole weeks on both sides pool
 *  ~700 vs ~2100 items, cancel the weekday effect without modelling it, and
 *  still move within days of a real screening change.
 *
 *  Counts only (PostgREST count=exact with no rows transferred), so this is
 *  four cheap queries rather than pulling a month of rows.
 */
export async function relevanceBaseline({ windowDays = 7, baselineWeeks = 3 } = {}) {
  const DAY = 864e5;
  const now = Date.now();
  const slice = async (fromMs, toMs) => {
    const range = `seen_at=gte.${new Date(fromMs).toISOString()}&seen_at=lt.${new Date(toMs).toISOString()}`;
    const [stored, relevant] = await Promise.all([
      countRows(`pr_items?${range}`),
      countRows(`pr_items?is_relevant=is.true&${range}`),
    ]);
    return { stored, relevant, rate: stored ? relevant / stored : null };
  };
  const winStart = now - windowDays * DAY;
  const baseStart = winStart - baselineWeeks * 7 * DAY;
  const [recent, baseline] = await Promise.all([
    slice(winStart, now),
    slice(baseStart, winStart),
  ]);
  return { recent, baseline, windowDays, baselineWeeks };
}

/** Board cards still showing "—" instead of a byline, long after the daily
 *  backfill should have taken them.
 *
 *  Measured as a SHARE, not a last-run time: on a quiet day a perfectly healthy
 *  backfill fills nothing, so a last-run test would false-alarm — and only about
 *  half of Egyptian stories carry an individual byline at all, so a raw count is
 *  never zero and grows with a busy fortnight. `relevant` is the denominator the
 *  caller needs to tell "wire copy is unsigned" from "every fetch is blocked".
 *  `stale` deliberately excludes the last `graceHours` so a story found this
 *  morning isn't counted against the sweep before the 05:00 run has seen it. */
export async function authorBacklog({ days = 14, graceHours = 36 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const before = new Date(Date.now() - graceHours * 36e5).toISOString();
  const window = `&or=(published_at.gte.${since},and(published_at.is.null,seen_at.gte.${since}))`;
  const [relevant, missing, stale] = await Promise.all([
    countRows(`pr_items?is_relevant=is.true${window}`),
    countRows(`pr_items?is_relevant=is.true&author=is.null${window}`),
    countRows(`pr_items?is_relevant=is.true&author=is.null&seen_at=lt.${before}${window}`),
  ]);
  return { relevant, missing, stale, days, graceHours };
}

/** This calendar month's API usage rows. THROWS when pr_usage hasn't been
    migrated, so the spend check reads 'unknown' rather than "$0.00 — all clear".
    Volume is a few hundred calls a month, so a month is cheap to pull and sum
    in JS rather than push an aggregate through PostgREST. */
export async function monthToDateUsage() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return rest(
    `pr_usage?select=stage,model,input_tokens,output_tokens,cache_create_tokens,cache_read_tokens,created_at` +
      `&created_at=gte.${from}&order=created_at.desc&limit=5000`
  );
}

/** Database size in bytes, via the db_size_bytes() RPC.
 *  READ-ONLY, and read-only by design: the function already exists in this
 *  Supabase project (the Regulatory Radar added it) and returns one aggregate
 *  number for the WHOLE database. PR Radar calls it and never defines it —
 *  a `create or replace` here would be this repo reaching into shared state,
 *  which the hard rules forbid. Throws (→ 'unknown') if it is ever dropped. */
export async function databaseSizeBytes() {
  const out = await rest('rpc/db_size_bytes', { method: 'POST', body: '{}' });
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error('db_size_bytes returned a non-number');
  return n;
}
