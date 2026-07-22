import { XMLParser } from 'fast-xml-parser';
import crypto from 'node:crypto';
import { ALL_FEEDS, BRAND_FEEDS } from '../lib/sources.js';
import { existingHashes, existingSummaryHashes, recentStories, recentItems, insertItems, insertInstances, instancesForItems, recordFeedHealth, brokenFeeds, activeSubscribers, getStateTime, touchState } from '../lib/db.js';
import { classify } from '../lib/classify.js';
import { semanticDedupe } from '../lib/dedupe-semantic.js';
import { postUrgentWebhook, postSurgeWebhook } from '../lib/notify.js';
import { detectSurges, renderSurgeEmail } from '../lib/surge.js';
import { renderBulletin, renderUrgent, sendBulletin } from '../lib/email.js';
import { authorFromEntry, fetchAuthor, cleanAuthor } from '../lib/author.js';
import { resolveUrl, isGoogleNews } from '../lib/resolve.js';

export const config = { maxDuration: 60 };

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// Pull a short plain-text snippet out of an RSS/Atom entry. Feeds already ship
// a 1-3 sentence summary (RSS <description>, Atom <summary>/<content>) in the
// payload — the classifier judges far better from headline + excerpt than from
// the headline alone. Google News packs an HTML list of related coverage in
// here; decoding entities and stripping tags still leaves useful signal.
// Truncated so one item never dominates the 25-item batch prompt.
const textOf = (f) => (f && typeof f === 'object' ? (f['#text'] ?? '') : (f ?? ''));
// HTML-entity decode for RSS text. Handles numeric (decimal + hex) and the
// common named entities. Google News double-encodes (&amp;#8220; -> &#8220;
// -> "), so a second pass unwraps that — otherwise curly quotes and dashes
// render as raw "&#8220;" text on the board and in emails.
const NAMED_ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°',
};
const decodeOnce = (s) => String(s).replace(
  /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
  (m, e) => {
    if (e[0] === '#') {
      const code = (e[1] === 'x' || e[1] === 'X')
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return m;
    }
    const c = NAMED_ENT[e] ?? NAMED_ENT[e.toLowerCase()];
    return c !== undefined ? c : m;
  }
);
const decodeEntities = (s) => {
  let out = decodeOnce(s);
  if (out.indexOf('&') !== -1) out = decodeOnce(out); // unwrap double-encoding
  return out;
};
function snippetOf(e) {
  const raw = textOf(e.description) || textOf(e.summary) ||
    textOf(e['content:encoded']) || textOf(e.content) || '';
  if (!raw) return '';
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, ' ')     // strip HTML tags (Google News wraps in <ol><li><a>…)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Dedupe on the story, not the article URL. Google News wraps links in
// redirect tokens that change, so hashing the URL would never match.
const hashOf = (title) =>
  crypto.createHash('sha256').update(title.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff ]/g, '').trim()).digest('hex');

// Reused for the summary hash \u2014 same normalisation so the two hashes are
// comparable in style, but built from Claude's paraphrase instead of the
// raw headline. Two publishers reporting the same story in different
// languages will still produce very similar summaries.
const summaryHashOf = (s) => (s ? hashOf(s) : null);

// Parse a CSV recipient list where each entry is either a bare email or
// a "Name <email>" pair (RFC 2822 style). Used for RADAR_TO_TEAM so we
// can personalise the greeting per recipient.
function parseNamedRecipients(csv) {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.+?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].trim(), email: m[2].trim() };
      return { name: null, email: entry };
    });
}

// Second dedupe layer: exact-hash catches "same headline reposted", but
// different publishers rewrite the same story with different words. Group
// by significant-token overlap (Jaccard) within the same country so we
// don't collapse different stories that happen to share vocabulary.
const STOPWORDS = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were','be','been',
  'by','with','from','as','that','this','these','those','says','said','have','has','had','will','can',
  'may','might','after','before','over','under','into','about','more','than','their','they','them',
  'new','news','report','reports','update','updates','latest','announces','announced','launches',
  'launched','opens','opened','plans','plan',
]);
function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\w\s\u0600-\u06ff]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
  );
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// PR variant: a story runs in many outlets, and coverage spread IS the signal.
// Keep EVERY cluster member as an "instance" (outlet · author · url · date),
// de-duped by url, so the board/email can list all the places one story ran
// under a single card.
function dedupeInstances(items) {
  const seen = new Map();
  for (const i of items) {
    const key = i.url || `${i.source || i.outlet}|${i.headline || ''}`;
    if (!seen.has(key)) {
      seen.set(key, {
        outlet: i.outlet ?? i.source ?? null,
        author: i.author ?? null,
        url: i.url || '',
        published_at: i.published_at || null,
      });
    }
  }
  return [...seen.values()];
}

function fuzzyDedupe(items) {
  const clusters = [];
  for (const item of items) {
    const tokens = tokenize(item.headline);
    const cluster = clusters.find(
      (c) => c.country === item.country && jaccard(c.tokens, tokens) >= 0.4
    );
    if (cluster) cluster.items.push(item);
    else clusters.push({ tokens, country: item.country, items: [item] });
  }
  return clusters.map((c) => {
    // Prefer highest-priority tier, then most recent.
    c.items.sort((a, b) => {
      const t = (a.tier || 9) - (b.tier || 9);
      return t || new Date(b.published_at || 0) - new Date(a.published_at || 0);
    });
    const chosen = { ...c.items[0] };
    chosen._instances = dedupeInstances(c.items);   // every outlet on this story
    if (c.items.length > 1) {
      const extras = [...new Set(c.items.slice(1).map((i) => i.source))];
      chosen.source = `${chosen.source} + ${extras.length} more`;
    }
    return chosen;
  });
}

// Second dedup pass — runs AFTER classify so it can compare Claude's
// paraphrased summaries. Catches the class the headline pass misses:
// - same story reported in two languages (headline tokens don't overlap,
//   summaries do because they're constrained-style paraphrases)
// - same story with very differently-worded headlines from two publishers
// Threshold higher than the headline pass (0.5) because summaries are
// shorter and more disciplined. No country grouping — a Kenyan take on
// an Egyptian story is still one story.
function summaryDedupe(items) {
  const clusters = [];
  for (const item of items) {
    if (!item.summary) { clusters.push({ tokens: new Set(), items: [item] }); continue; }
    const tokens = tokenize(item.summary);
    const cluster = clusters.find((c) => jaccard(c.tokens, tokens) >= 0.5);
    if (cluster) cluster.items.push(item);
    else clusters.push({ tokens, items: [item] });
  }
  return clusters.map((c) => {
    // Prefer highest importance, then most recent.
    c.items.sort((a, b) => {
      const imp = (b.importance || 0) - (a.importance || 0);
      return imp || new Date(b.published_at || 0) - new Date(a.published_at || 0);
    });
    const chosen = { ...c.items[0] };
    // Members may already carry _instances from the fuzzy pass; flatten those so
    // an Arabic + English cluster ends up with all its outlets on one card.
    const all = c.items.flatMap((i) => (i._instances && i._instances.length ? i._instances : [i]));
    chosen._instances = dedupeInstances(all);
    if (c.items.length > 1) {
      const extras = [...new Set(c.items.slice(1).map((i) => i.source).filter(Boolean))];
      if (extras.length) chosen.source = `${chosen.source} + ${extras.length} more`;
    }
    return chosen;
  });
}

// Present as a browser. Some regulator sites and Cloudflare-protected
// outlets 403 anything that looks like a generic bot; polite crawlers
// with a browser UA get through.
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,ar;q=0.6',
};

// Parse a feed's date defensively. A malformed pubDate/published (Wamda and
// some Atom feeds ship non-standard strings) makes `new Date(pub)` an Invalid
// Date, and `.toISOString()` then THROWS "Invalid time value". Inside the map
// below that threw out of the whole feed, so ONE bad item silently sank all 30
// and flipped the feed to unhealthy. Returning null keeps the item (freshness
// retains null-dated items) and keeps the feed alive.
function safeIso(pub) {
  if (!pub) return null;
  const d = new Date(pub);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(feed.url, { signal: ctrl.signal, headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const xml = parser.parse(await res.text());
    const entries = arr(xml?.rss?.channel?.item).concat(arr(xml?.feed?.entry));

    const items = entries.slice(0, 30).map((e) => {
      const title = decodeEntities(String(e.title?.['#text'] ?? e.title ?? '').trim());
      const link = e.link?.['@_href'] ?? e.link ?? '';
      const pub = e.pubDate ?? e.published ?? e.updated ?? null;
      // Google News formats titles as "Headline - Publisher"
      const dash = title.lastIndexOf(' - ');
      return {
        headline: dash > 20 ? title.slice(0, dash) : title,
        source: dash > 20 ? title.slice(dash + 3) : feed.id,
        author: authorFromEntry(e),          // RSS byline (<dc:creator>/<author>) when present, else null
        snippet: snippetOf(e),
        url: String(link),
        published_at: safeIso(pub),
        tier: feed.tier,
        brand: feed.brand ?? null,           // brand the feed targets; the classifier can override
        country: feed.country,
      };
    });

    await recordFeedHealth(feed.id, true);
    return items.filter((i) => i.headline.length > 15);
  } catch (e) {
    await recordFeedHealth(feed.id, false, e.message).catch(() => {});
    return [];
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const qtoken = req.query?.t;
  const ok =
    auth === `Bearer ${process.env.CRON_SECRET}` ||
    auth === `Bearer ${process.env.RADAR_TOKEN}` ||
    qtoken === process.env.RADAR_TOKEN;
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  const dry = req.query?.dry === '1';
  // Hourly external scheduler passes urgentOnly=1: skip the regular
  // bulletin (would just report "nothing cleared screening" most hours),
  // still fire urgent alerts for anything importance-5 that just landed.
  const urgentOnly = req.query?.urgentOnly === '1';
  // ?to=<email> runs the REAL daily path but delivers the admin + team
  // bulletins to that ONE address instead of the RADAR_TO / RADAR_TO_TEAM
  // lists — and skips the watchlist and urgent blasts. Lets you prove the
  // actual scheduled send end-to-end without emailing the whole team.
  const previewTo = req.query?.to || null;
  const previewName = req.query?.name || null;

  // 1. Fetch feeds in parallel. A dead feed yields [] and is logged.
  //    Urgent-only crisis polls (every 15–30 min) hit ONLY the brand-targeted
  //    queries — a tight, fast net over the four operators — so the poll stays
  //    cheap. The daily full run sweeps ALL_FEEDS (brands + market + outlets).
  //    Cross-run hash dedupe (existingHashes below) means a story the poll
  //    already ingested/alerted never re-alerts on the next poll or the daily run.
  const feedSet = urgentOnly ? BRAND_FEEDS : ALL_FEEDS;
  const results = await Promise.allSettled(feedSet.map(fetchFeed));
  const raw = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  // 2. Drop anything older than 48h.
  const cutoff = Date.now() - 2 * 864e5;
  const fresh = raw.filter((i) => !i.published_at || new Date(i.published_at).getTime() > cutoff);

  // 3. Dedupe: within this run (exact then fuzzy), then against everything ever seen.
  const byHash = new Map();
  for (const i of fresh) {
    const h = hashOf(i.headline);
    if (!byHash.has(h)) byHash.set(h, { ...i, hash: h });
  }
  const deduped = fuzzyDedupe([...byHash.values()]);
  const seen = await existingHashes(deduped.map((i) => i.hash));
  const notReposted = deduped.filter((i) => !seen.has(i.hash));

  // Cross-run fuzzy dedup. The hash checks only catch an EXACT repost; a
  // publisher rewording a story we stored earlier (different hash) — or an
  // Arabic/English pair of the same story — slips through as duplicate
  // cards, no matter how many hours separate the two versions. Fetch the
  // recently-stored stories ONCE and reuse them for two passes:
  //   1. headline tokens, same country, Jaccard >= 0.4 (before classify)
  //   2. summary tokens, any country, Jaccard >= 0.5 (after classify)
  // Same thresholds/grouping as the within-run passes, so it's consistent.
  const recentHeadTokensByCountry = new Map();
  const recentSummaryTokens = [];
  const recentSummaryTexts = [];
  for (const r of await recentStories()) {
    const key = r.country || '';
    if (!recentHeadTokensByCountry.has(key)) recentHeadTokensByCountry.set(key, []);
    recentHeadTokensByCountry.get(key).push(tokenize(r.headline));
    if (r.summary) { recentSummaryTokens.push(tokenize(r.summary)); recentSummaryTexts.push(r.summary); }
  }
  const candidates = notReposted.filter((i) => {
    const toks = tokenize(i.headline);
    const pool = recentHeadTokensByCountry.get(i.country || '') || [];
    return !pool.some((t) => jaccard(t, toks) >= 0.4);
  });
  const crossRunHeadlineDropped = notReposted.length - candidates.length;

  // Nothing NEW this run. For an hourly urgent-only check that's the end of
  // it — no classify, no digest to send. But the daily FULL run must not stop
  // here: the overnight urgent-checks have already ingested everything, so the
  // 04:00 run routinely finds zero new candidates, and an early return skips
  // the 24h digest bulletin below entirely — which is exactly why the morning
  // bulletin silently stopped going out. Fall through instead; classify([]) is
  // a no-op (0 batches, 0 calls) and the digest is rebuilt from the DB.
  if (!candidates.length && urgentOnly) {
    return res.status(200).json({ scanned: raw.length, new: 0, note: 'nothing new' });
  }

  // 4. Classify. Fixed call count: ceil(n / 25).
  const rawClassified = await classify(candidates);

  // Items the classifier gave up on (unparseable batch even after splitting, or
  // an index the model omitted) — stored is_relevant:false so they never reach
  // the board, but surfaced in the bulletin footer + run stats so a silent
  // classifier failure is visible instead of reading as "a quiet news day".
  const unclassifiedCount = rawClassified.filter(
    (i) => i.is_relevant === false && i.category === 'unclassified'
  ).length;

  // 4a. Post-classify dedup on the classifier's paraphrased summary.
  //     Exact-hash collapse first (works cross-language when Claude
  //     paraphrases the same story into similar wording), then a
  //     token-overlap pass to catch near-paraphrases. Also compare
  //     against summary hashes already in the DB so yesterday's item
  //     doesn't reappear under a new headline.
  for (const item of rawClassified) item.summary_hash = summaryHashOf(item.summary);

  // classify() normalises to a fixed key set (PGRST102 safety), dropping the
  // transient _instances (the outlet cluster) captured before classify. Re-attach
  // it by hash so the instance write + author backfill below have it. Default
  // resolved_url on EVERY item so the batch insert keys stay uniform (author is
  // already carried through classify from the RSS byline).
  const instByHash = new Map(candidates.map((c) => [c.hash, c._instances || []]));
  for (const item of rawClassified) {
    item._instances = instByHash.get(item.hash) || [];
    item.resolved_url = null;
  }

  const bySummaryHash = new Map();
  for (const it of rawClassified) {
    // Items without a summary keep a unique key so they aren't collapsed
    // together (missing summary usually means classify failed for that
    // one — dedup would silently lose it otherwise).
    const key = it.summary_hash || `nosum-${it.hash}`;
    if (!bySummaryHash.has(key)) bySummaryHash.set(key, it);
  }
  const summaryDeduped = summaryDedupe([...bySummaryHash.values()]);

  // Cross-run: skip items whose summary matches one already in the DB —
  // exact summary_hash first, then a fuzzy token pass against recent stored
  // summaries. The fuzzy pass catches the case the headline pass can't: a
  // cross-language repost whose headline shares no words but whose
  // paraphrased summary overlaps (Jaccard >= 0.5, matching the within-run
  // summary bar).
  const seenSummaries = await existingSummaryHashes(summaryDeduped.map((i) => i.summary_hash));
  let classified = summaryDeduped.filter((i) => {
    if (i.summary_hash && seenSummaries.has(i.summary_hash)) return false;
    if (i.summary) {
      const toks = tokenize(i.summary);
      if (recentSummaryTokens.some((t) => jaccard(t, toks) >= 0.5)) return false;
    }
    return true;
  });
  const crossRunSummaryDropped = summaryDeduped.length - classified.length;

  // 4a-bis. Semantic dedup backstop. The lexical passes above miss the same
  // event reported with different FRAMING — a competitor's press release vs the
  // regulator's own wording — because the summaries share too few words. This
  // asks a cheap model, only for borderline pairs, "same underlying event?" and
  // drops confirmed reposts. Fail-open (keeps everything on any error), so it
  // can only ever remove a true duplicate, never lose a story.
  let semanticDropped = 0;
  try {
    const before = classified.length;
    classified = await semanticDedupe(classified, recentSummaryTexts);
    semanticDropped = before - classified.length;
  } catch (e) {
    console.error('semantic dedupe skipped', e.message);
  }

  // Author + link backfill (the core "who published it, where" hop): for every
  // relevant board item whose primary instance has no RSS byline, resolve the
  // (usually Google-News-wrapped) URL to the real publisher link, then fetch the
  // article and extract the author. Covers ALL relevant items (cap 30, highest-
  // severity first) so the board isn't left with "—" on lower-severity cards.
  // Parallel, fail-soft (a miss leaves author null → "—"). The resolved URL is
  // cached onto the item so the insert below populates resolved_url — making
  // /api/go shares instant from day one — and the card's primary link becomes the
  // clean publisher URL, not the un-tappable Google wrapper. Skipped on the
  // hourly urgent-only check (protect its speed) and on dry smoke-tests.
  if (!dry && !urgentOnly) {
    await Promise.all(
      classified
        .filter((i) => i.is_relevant)
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .slice(0, 30)
        .map(async (it) => {
          const insts = it._instances || [];
          const primary = insts[0] || { url: it.url, author: it.author };

          // Resolve the primary URL once (direct links short-circuit, no fetch).
          let resolved = primary.url;
          try { resolved = await resolveUrl(primary.url); } catch { /* keep original */ }
          if (resolved && !isGoogleNews(resolved)) {
            it.resolved_url = resolved;            // cache onto the card row
            if (insts[0]) insts[0].url = resolved; // primary instance gets the clean link
          }

          // An instance byline from RSS wins — no fetch needed. cleanAuthor()
          // rejects outlet-as-author values (feeds often put the site name in
          // <dc:creator>) and salvages the person from compound desk bylines
          // ("محمد علي - خاص"), so a publication is never shown as a person but
          // a real name attached to one isn't thrown away either.
          let rssAuthor = null;
          for (const x of insts) {
            rssAuthor = cleanAuthor(x.author, x.outlet);
            if (rssAuthor) break;
          }
          if (rssAuthor) { it.author = it.author || rssAuthor; return; }

          // Otherwise fetch — try the primary resolved URL, then fall back to the
          // OTHER outlets' direct (non-Google) URLs, since a story often ran in
          // several places and only some resolve or expose a byline.
          const urls = [...new Set(
            [resolved, ...insts.map((x) => x.url)].filter((u) => u && !isGoogleNews(u))
          )];
          for (const u of urls) {
            const person = cleanAuthor(await fetchAuthor(u), (insts[0] && insts[0].outlet) || it.source);
            if (person) { it.author = person; if (insts[0]) insts[0].author = person; break; }
          }
        })
    );
  }

  const relevant = classified.filter((i) => i.is_relevant && i.importance >= 2);
  const urgent = relevant.filter((i) => i.importance === 5);

  if (!dry && !previewTo) {
    // insertItems returns the inserted rows (with DB ids). Splice them back onto
    // the in-memory items so the urgent + bulletin emails can deep-link to
    // #item-<id> on the board. Strip transient fields (snippet, _instances) that
    // aren't pr_items columns — a batch INSERT with non-uniform keys is rejected
    // wholesale (PGRST102). author + resolved_url ARE columns and stay, written
    // here pre-populated by the backfill above. Then write every outlet that ran
    // the story to pr_instances against the new ids.
    const inserted = await insertItems(
      classified.map(({ refined, snippet, _instances, ...row }) => row)
    );
    const idByHash = new Map((inserted || []).map((r) => [r.hash, r.id]));
    const instanceRows = [];
    for (const item of classified) {
      const id = idByHash.get(item.hash);
      if (id == null) continue;
      item.id = id;
      for (const inst of item._instances || []) {
        instanceRows.push({
          item_id: id,
          outlet: inst.outlet,
          author: cleanAuthor(inst.author, inst.outlet),
          url: inst.url,
          published_at: inst.published_at,
        });
      }
    }
    if (instanceRows.length) {
      try { await insertInstances(instanceRows); }
      catch (e) { console.error('instance write failed (non-fatal)', e.message); }
    }
  }

  // 5a. Urgent alerts fire FIRST, one email per importance-5 item. They
  // also appear in the bulletin below — this is a signal not a filter.
  // Cross-run dedupe on hash guarantees we alert once per story.
  const boardUrl = process.env.BOARD_URL || '';
  if (!dry && !previewTo && urgent.length) {
    await Promise.all(
      urgent.map((item) => {
        const subject = `URGENT — ${item.headline}`.slice(0, 140);
        // Email is the primary channel; the optional webhook (Slack/Teams/
        // WhatsApp-via-bridge) fires alongside it and is fail-soft internally.
        return Promise.all([
          sendBulletin(renderUrgent(item, boardUrl), subject).catch((e) => {
            console.error('urgent send failed', item.hash, e.message);
          }),
          postUrgentWebhook(item, boardUrl),
        ]);
      })
    );
  }

  // 5a-bis. Cross-item SURGE detection — the aggregate crisis signal the
  // per-item urgent path can't give (ten importance-3 stories, none severity-5,
  // but abnormal VOLUME). Runs on every run that got this far (daily + each
  // urgent poll), reading a live rolling baseline from the DB — no new tables.
  // ONE alert per surging brand, throttled via pr_state so a poll can't re-fire
  // the same surge. Detection + logging always happen; the email/webhook only
  // go out when SURGE_ALERTS_ENABLED=1 (off by default — a new heuristic
  // shouldn't email the team until it's been watched). Fail-soft end to end.
  let surgeCount = 0;
  if (!dry && !previewTo) {
    try {
      const surges = await detectSurges();
      const throttleMs = (Number(process.env.SURGE_THROTTLE_HOURS) || 12) * 3600e3;
      const fresh = [];
      for (const s of surges) {
        const last = await getStateTime(`surge:${s.brand}`).catch(() => 0);
        if (last && Date.now() - last < throttleMs) continue;   // already alerted this window
        fresh.push(s);
      }
      surgeCount = fresh.length;
      if (fresh.length) {
        console.warn('SURGE:', fresh.map((s) => `${s.brand} ${s.today} vs ~${s.mean} (${s.multiple}x)`).join('; '));
        if (process.env.SURGE_ALERTS_ENABLED === '1') {
          const to = process.env.SURGE_TO || process.env.RADAR_TO;
          const subject = `SURGE — ${fresh.map((s) => s.brand).join(', ')} negative coverage spike`.slice(0, 140);
          try {
            await sendBulletin(renderSurgeEmail(fresh, boardUrl), subject, to);
          } catch (e) {
            console.error('surge email failed', e.message);
          }
          // Stamp the throttle + push the webhook only when we actually alerted,
          // so enabling the feature mid-surge still fires the first alert.
          await Promise.all(fresh.flatMap((s) => [
            postSurgeWebhook(s, boardUrl),
            touchState(`surge:${s.brand}`).catch(() => {}),
          ]));
        }
      }
    } catch (e) {
      console.error('surge detection skipped (non-fatal)', e.message);
    }
  }

  // 5b. Regular bulletin — everything that cleared the bar. Skipped for
  // hourly urgent-only runs.
  //
  // Two variants:
  //   admin — full scope (all tiers), sent to RADAR_TO. Mirrors the admin board.
  //   team  — Egypt-only, mirrors team.html: tier 1, importance >= 2,
  //           admin didn't thumb-down (feedback != -1) and didn't force-hide
  //           (team_share is not false). Sent to RADAR_TO_TEAM if set.
  const broken = await brokenFeeds().catch(() => []);

  // Daily bulletin is a 24h DIGEST of everything relevant on the board —
  // not just what this run newly found. The hourly overnight runs store
  // items as they appear, so a "this-run only" bulletin is near-empty by
  // 04:00. Pull the last 24h of relevant items (importance >= 2) from the
  // DB (this run's inserts are already in it), merged with this run's items
  // so a dry preview is accurate too. The urgent alerts above stay
  // real-time (this run's new 5s) so nothing is ever re-alerted.
  let digest = [];
  if (!urgentOnly) {
    const digestByHash = new Map();
    for (const it of await recentItems({ days: 1 }).catch(() => [])) {
      if ((it.importance || 0) >= 2) digestByHash.set(it.hash, it);
    }
    for (const it of relevant) if (!digestByHash.has(it.hash)) digestByHash.set(it.hash, it);
    digest = [...digestByHash.values()];
  }

  let bulletinSent = false;
  // Idempotency for the REAL daily send: the Vercel cron (04:00 UTC) and the
  // GitHub Actions backup (04:10 UTC) both hit this path — send the bulletin
  // at most once per day. A preview (?to=) always sends to its one address and
  // ignores the marker; a dry run never sends. Fail OPEN: a marker-read error
  // sends anyway (a double-send is harmless; a suppressed send is the exact
  // failure this whole change is guarding against).
  const DAILY_KEY = 'daily_bulletin_sent';
  let dailyAlreadySent = false;
  if (!urgentOnly && !previewTo && !dry) {
    const last = await getStateTime(DAILY_KEY).catch(() => 0);
    dailyAlreadySent = last > 0 && (Date.now() - last) < 12 * 3600e3;
  }

  // Final pre-send dedup sweep on the 24h digest. The ingest passes dedup each
  // NEW item against the last 5 days, but a same-event straggler that slipped
  // an earlier run (or predates a gate change) can still be sitting in the DB
  // and land in the digest. Re-cluster the digest ITSELF right before render so
  // the bulletin shows one card per event. Sort by importance first so the
  // highest-importance card is the survivor. One Haiku call, fail-open
  // (semanticDedupe returns everything unchanged on any error) — only runs when
  // a bulletin is actually about to go out, so it's ~one call/day.
  if (!urgentOnly && !dry && !dailyAlreadySent && digest.length > 1) {
    try {
      digest.sort((a, b) =>
        (b.importance || 0) - (a.importance || 0) ||
        new Date(b.published_at || b.seen_at || 0) - new Date(a.published_at || a.seen_at || 0));
      const before = digest.length;
      digest = await semanticDedupe(digest, []);
      if (digest.length !== before) console.log(`pre-send digest dedup: collapsed ${before - digest.length} straggler(s)`);
    } catch (e) {
      console.error('pre-send digest dedup skipped', e.message);
    }
  }

  // Attach coverage instances (every outlet that ran each story) so the render
  // can show the full "Coverage · N outlets" list with per-outlet bylines.
  // Authoritative from pr_instances; falls back to the in-memory _instances for a
  // dry preview whose rows were never inserted.
  if (!urgentOnly && digest.length) {
    try {
      const instMap = await instancesForItems(digest.map((i) => i.id).filter(Boolean));
      for (const it of digest) it._instances = instMap[it.id] || it._instances || [];
    } catch (e) { console.error('instances fetch for render failed (non-fatal)', e.message); }
  }

  if (!urgentOnly && !dailyAlreadySent) {
    // The daily PR brief — one send per recipient with a personalised greeting.
    // RADAR_TO accepts "Name <email>" entries so each recipient gets "Hi <Name>, …".
    const neg = digest.filter((i) => i.sentiment === 'negative').length;
    const adminSubject = `PR Radar — ${digest.length} item${digest.length === 1 ? '' : 's'}${neg ? `, ${neg} negative` : ''}`;
    const adminRecipients = previewTo
      ? [{ name: previewName, email: previewTo }]
      : parseNamedRecipients(process.env.RADAR_TO);
    let adminCount = 0;
    for (const r of adminRecipients) {
      const html = renderBulletin({ items: digest, broken, scanned: raw.length, variant: 'admin', greetingName: r.name || null, unclassified: unclassifiedCount });
      if (!dry) {
        try {
          await sendBulletin(html, adminSubject, r.email, { bcc: previewTo ? undefined : process.env.RADAR_BCC });
          adminCount++;
        } catch (e) {
          console.error('admin send failed', r.email, e.message);
        }
      } else {
        adminCount++;
      }
    }
    bulletinSent = adminCount > 0 && !dry;

    // Mark the daily send done so a second trigger today is a no-op. Only for
    // a real send that actually went out (not preview / dry, and something was
    // sent). touchState failing is non-fatal — worst case the backup double-sends.
    if (!previewTo && !dry && bulletinSent) {
      await touchState(DAILY_KEY).catch(() => {});
    }
  }

  // 5c. Watchlist emails — per-subscriber filtered digests. A subscriber
  // with NULL/empty categories gets the whole bulletin (same as RADAR_TO);
  // a subscriber with categories set gets only items matching those
  // categories. Empty filtered set → skip that subscriber (no zero-item
  // email). Failures per-subscriber are logged, never fatal.
  // Gated by !dailyAlreadySent (same guard as the admin/team sends above) so
  // the 04:10 GitHub backup can't re-send today's digest to subscribers after
  // the 04:00 Vercel cron already delivered it.
  let watchlistSent = 0;
  if (!urgentOnly && !dry && !previewTo && !dailyAlreadySent && digest.length) {
    const subs = await activeSubscribers().catch((e) => {
      console.error('subscribers fetch failed', e.message);
      return [];
    });
    for (const sub of subs) {
      const cats = Array.isArray(sub.categories) ? sub.categories.filter(Boolean) : [];
      const filtered = cats.length
        ? digest.filter((i) => cats.includes(i.category))
        : digest;
      if (!filtered.length) continue;
      const catLabel = cats.length
        ? cats.map((c) => c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())).join(', ')
        : null;
      // Match the admin bulletin subject: append ", N needing attention" when
      // this subscriber's set has any importance-4+ item, so a full-digest
      // subscriber's inbox surfaces urgency exactly like the RADAR_TO copy.
      const subTop = filtered.filter((i) => (i.importance || 0) >= 4).length;
      const subAttn = subTop ? `, ${subTop} needing attention` : '';
      const subject = catLabel
        ? `PR Radar — ${filtered.length} in ${catLabel}${subAttn}`
        : `PR Radar — ${filtered.length} items${subAttn}`;
      const greeting = sub.name
        ? `Hi ${sub.name}, Greetings — this is your daily brand & reputation brief${catLabel ? ` — ${catLabel}` : ''}.`
        : null;
      const html = renderBulletin({ items: filtered, broken, scanned: raw.length, greeting });
      try {
        await sendBulletin(html, subject, sub.email);
        watchlistSent++;
      } catch (e) {
        console.error('watchlist send failed', sub.email, e.message);
      }
    }
  }

  return res.status(200).json({
    scanned: raw.length,
    feeds: feedSet.length,
    surges: surgeCount,
    candidates: candidates.length,
    crossRunHeadlineDropped,
    crossRunSummaryDropped,
    classified: rawClassified.length,
    unclassified: unclassifiedCount,
    afterSummaryDedup: classified.length,
    droppedAsDupe: rawClassified.length - classified.length,
    semanticDropped,
    digestCount: digest.length,
    emailed: bulletinSent ? digest.length : 0,
    dailyAlreadySent,
    urgent: urgent.length,
    watchlist: watchlistSent,
    brokenFeeds: broken.map((b) => b.feed_id),
    urgentOnly,
    dry,
  });
}
