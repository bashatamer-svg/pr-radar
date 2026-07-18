// Shared Google News URL resolver. The pipeline stores each item's `url` as the
// Google News RSS wrapper (news.google.com/rss/articles/CBMi…). Those tokens are
// meant to be DECODED, not opened — they 404 to a raw XML error page if tapped,
// and they can't be fetched for an author byline (you'd read Google's shell, not
// the article). This turns a wrapper into the real publisher URL.
//
// Two strategies, best-effort, in order:
//   A. follow the redirect chain (undici sets res.url to the landing page);
//   B. Google's internal batchexecute decode (signature + timestamp from the
//      article shell authorise a call that returns the real URL).
// On any failure it returns the ORIGINAL url — never worse than before.
//
// IMPORTANT: resolution only works where the runtime can reach Google. That is
// TRUE on Vercel (where the cron runs) and FALSE in a local/sandbox. So this is
// safe to call from api/radar.js and api/go.js; do not expect it to resolve
// offline. It never throws.
//
// This is the same logic api/go.js uses; extracted here so the author backfill
// can share it. (go.js can later import { resolveUrl } from here to de-dupe —
// optional, not required; leaving go.js untouched keeps a working endpoint safe.)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function safeHost(u) { try { return new URL(u).host; } catch { return ''; } }
export const isGoogleNews = (u) => /(^|\.)news\.google\.com$/i.test(safeHost(u));

async function fetchT(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Strategy A — follow the redirect chain.
async function viaRedirect(url) {
  try {
    const res = await fetchT(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (res.url && !isGoogleNews(res.url)) return res.url;
  } catch { /* fall through */ }
  return null;
}

// Strategy B — Google News' internal batchexecute decode.
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

// Resolve a URL to the real publisher link. Returns the ORIGINAL url if it's
// already a real link, or if decoding fails. Never throws.
export async function resolveUrl(url) {
  if (!url) return url;
  if (!isGoogleNews(url)) return url;           // already a real link
  const a = await viaRedirect(url);
  if (a) return a;
  const b = await viaBatchExecute(url);
  if (b) return b;
  return url;                                    // couldn't decode — original wrapper
}
