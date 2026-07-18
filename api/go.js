// Share-redirect: turn a card's stored Google News wrapper into a clean,
// tappable link to the real article.
//
// The pipeline stores each item's `url` as the Google News RSS wrapper
// (https://news.google.com/rss/articles/CBMi…?oc=5). Those tokens are meant
// to be *decoded*, not opened — pasted into WhatsApp they're a 2,000-char
// string, and tapped they land on Google News' raw XML error page ("This feed
// is not available"). So the board's "article link" now points here instead:
//
//   GET /api/go?id=<itemId>   → 302 to the real publisher URL
//   GET /api/go?id=<itemId>&debug=1 → JSON {strategy, from, to} (no redirect)
//
// The shared link (…/api/go?id=2179) is short and branded; resolution happens
// server-side, where Vercel *can* reach Google (the sandbox can't), and the
// decoded URL is cached back onto the row so the next share is instant.
//
// Public on purpose: a shared link goes to anyone, and it only ever redirects
// to a URL we already stored from a feed (no open-redirect — there is no
// caller-supplied destination). If resolution fails it falls back to the
// original wrapper, so the link is never *worse* than before.

import { itemLink, setResolvedUrl } from '../lib/db.js';

export const config = { maxDuration: 15 };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const isGoogleNews = (u) => /(^|\.)news\.google\.com$/i.test(safeHost(u));
function safeHost(u) { try { return new URL(u).host; } catch { return ''; } }

// Fetch with a hard timeout so a slow Google response can't hang the redirect.
async function fetchT(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Strategy A — just follow the redirect chain. undici sets res.url to the
// final landing URL; if that's left news.google.com we already have the
// publisher link, no decoding needed.
async function viaRedirect(url) {
  try {
    const res = await fetchT(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (res.url && !isGoogleNews(res.url)) return res.url;
  } catch { /* fall through */ }
  return null;
}

// Strategy B — Google News' internal batchexecute decode. The RSS wrapper's
// last path segment is an opaque token; the article shell exposes a signature
// (data-n-a-sg) + timestamp (data-n-a-ts) that authorise a batchexecute call
// which returns the real URL. Google changes this periodically, so it's
// wrapped in try/catch and treated as best-effort, never load-bearing.
async function viaBatchExecute(url) {
  try {
    const token = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!token) return null;
    const shellRes = await fetchT(`https://news.google.com/rss/articles/${token}`,
      { headers: { 'User-Agent': UA } });
    const html = await shellRes.text();
    const sig = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts  = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    const id  = html.match(/data-n-a-id="([^"]+)"/)?.[1] || token;
    if (!sig || !ts) return null;

    const inner = JSON.stringify(['garturlreq',
      [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
       'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id, Number(ts), sig]);
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));

    const beRes = await fetchT(
      'https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je',
      { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
    const text = await beRes.text();
    const line = text.split('\n').find((l) => l.includes('garturlres'));
    if (!line) return null;
    const decoded = JSON.parse(JSON.parse(line)[0][2])[1];
    return decoded && !isGoogleNews(decoded) ? decoded : null;
  } catch { return null; }
}

async function resolve(url) {
  if (!url) return { to: url, strategy: 'none' };
  if (!isGoogleNews(url)) return { to: url, strategy: 'direct' }; // already a real link
  const a = await viaRedirect(url);
  if (a) return { to: a, strategy: 'redirect' };
  const b = await viaBatchExecute(url);
  if (b) return { to: b, strategy: 'batchexecute' };
  return { to: url, strategy: 'fallback' };  // couldn't decode — original wrapper
}

export default async function handler(req, res) {
  const id = req.query?.id;
  const debug = req.query?.debug;
  const row = await itemLink(id).catch(() => null);

  if (!row) {
    if (debug) return res.status(404).json({ error: 'unknown id', id });
    return res.status(404).send('Not found');
  }

  // Cache hit: a real URL was decoded on an earlier share — use it straight away.
  if (row.resolved_url && !isGoogleNews(row.resolved_url)) {
    if (debug) return res.status(200).json({ id: row.id, from: row.url, to: row.resolved_url, strategy: 'cache' });
    return redirect(res, row.resolved_url, true);
  }

  const { to, strategy } = await resolve(row.url);
  if (strategy === 'redirect' || strategy === 'batchexecute') {
    setResolvedUrl(row.id, to).catch(() => {});   // fire-and-forget cache write
  }

  if (debug) return res.status(200).json({ id: row.id, from: row.url, to, strategy });
  // Only cache a confidently-resolved link; a fallback might resolve properly
  // next time (Google flakiness), so don't let a browser pin the wrapper.
  return redirect(res, to, strategy !== 'fallback');
}

function redirect(res, url, cacheable) {
  res.setHeader('Location', url);
  if (cacheable) res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(302).end();
}
