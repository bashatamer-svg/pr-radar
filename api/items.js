import { recentItems, itemsByIds, instancesForItems } from '../lib/db.js';
import { requireRole, auditReq } from '../lib/auth.js';

// Auth: viewers (and above) may read the board; only admins may mutate an item
// (pin/hide/vote). A legacy ?t=<RADAR_TOKEN> or a cron secret resolves to a
// service-admin principal, so existing links and jobs keep working.
export default async function handler(req, res) {
  if (req.method === 'PATCH') {
    const who = await requireRole(req, res, 'admin');
    if (!who) return;
    const { id, feedback, team_share } = req.body || {};
    // Only forward fields that were actually sent, so we never null out
    // team_share when the caller is only updating feedback (or vice versa).
    const patch = {};
    if (feedback !== undefined) patch.feedback = Number(feedback);
    if (team_share !== undefined) {
      // null = follow the algorithm; true = force-share; false = force-hide.
      patch.team_share = team_share === null ? null : Boolean(team_share);
      // Stamp when the pin state was set so we can expire pins after
      // PIN_DAYS. On true (fresh pin) stamp now; on false or null clear
      // the timestamp — an unpin should not leave a dangling stamp behind.
      patch.team_share_at = patch.team_share === true ? new Date().toISOString() : null;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pr_items?id=eq.${Number(id)}`, {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
    await auditReq(req, who, 'item.update', id, patch);
    return res.status(204).end();
  }

  // Reads require a signed-in viewer (or a service token / cron secret).
  const who = await requireRole(req, res, 'viewer');
  if (!who) return;

  // Fetch specific items by id (the board's "Saved" filter — starred items may
  // be older than the current window) or the recent window.
  const rows = req.query.ids
    ? await itemsByIds(String(req.query.ids).split(','))
    : await recentItems({ days: Math.min(Number(req.query.days) || 7, 30) });

  // Attach coverage instances (outlet · author · url · date) per card so the
  // board can render the "who published it, everywhere it ran" list. Non-fatal:
  // cards still render without it.
  try {
    const map = await instancesForItems((rows || []).map((r) => r.id).filter(Boolean));
    for (const r of rows) r.instances = map[r.id] || [];
  } catch (e) {
    console.error('instances attach failed (non-fatal)', e.message);
  }
  return res.status(200).json(rows);
}
