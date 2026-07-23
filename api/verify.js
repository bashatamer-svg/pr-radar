// Branded sign-in hop. The magic-link email points here — on the board's own
// domain — instead of exposing the raw <ref>.supabase.co verify URL. Same sender
// and link domain is what corporate mail filters trust, so the link stops being
// quarantined. We only ever redirect to THIS project's GoTrue verify endpoint
// (open-redirect guard), never to an arbitrary URL.
export default function handler(req, res) {
  const u = req.query.u;
  if (!u) return res.status(400).send('missing sign-in token');
  let target;
  try {
    target = Buffer.from(String(u).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return res.status(400).send('malformed sign-in link'); }
  let url;
  try { url = new URL(target); } catch { return res.status(400).send('malformed sign-in link'); }

  let allowedHost = null;
  try { allowedHost = new URL(process.env.SUPABASE_URL).host; } catch { allowedHost = null; }
  const ok = url.protocol === 'https:' && allowedHost && url.host === allowedHost && url.pathname.startsWith('/auth/');
  if (!ok) return res.status(400).send('invalid sign-in link');

  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store, max-age=0' });
  res.end();
}
