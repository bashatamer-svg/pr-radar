// Living-knowledge editor endpoint. Token-gated exactly like api/items.js.
//
//   GET  /api/context?t=<RADAR_TOKEN>   → { content, updated_at }
//   PUT  /api/context?t=<RADAR_TOKEN>    (body {content}) → save, returns meta
//
// Backs /context.html. The doc is pr_context.house_knowledge — the admin-
// maintained "living PR knowledge" (current campaigns, a live issue, a
// spokesperson change) that lib/house-context.js injects into EVERY
// classification. Editing it here changes how the next run classifies, with no
// redeploy. Scope is public market facts only (see lib/house-context.js).

import { getHouseKnowledge, houseKnowledgeUpdatedAt, setHouseKnowledge } from '../lib/db.js';
import { requireRole, auditReq } from '../lib/auth.js';

const MAX = 20000;   // guardrail — this text is prepended to every batch prompt.

export default async function handler(req, res) {
  if (req.method === 'PUT' || req.method === 'POST') {
    const who = await requireRole(req, res, 'admin');   // editing house knowledge is an admin action
    if (!who) return;
    const body = req.body || {};
    const content = typeof body === 'string' ? body : body.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    if (content.length > MAX) return res.status(413).json({ error: `content too long (max ${MAX} chars)` });
    try {
      await setHouseKnowledge(content);
      const updated_at = await houseKnowledgeUpdatedAt().catch(() => new Date().toISOString());
      await auditReq(req, who, 'context.edit', 'house_knowledge', { length: content.length });
      return res.status(200).json({ ok: true, updated_at, length: content.length });
    } catch (e) {
      console.error('context save failed', e.message);
      return res.status(500).json({ error: 'save failed', detail: e.message });
    }
  }

  // GET — current doc + when it was last edited (viewers may read).
  const who = await requireRole(req, res, 'viewer');
  if (!who) return;
  const [content, updated_at] = await Promise.all([
    getHouseKnowledge().catch(() => ''),
    houseKnowledgeUpdatedAt().catch(() => null),
  ]);
  return res.status(200).json({ content: content || '', updated_at, max: MAX });
}
