// Subscriber + feedback admin endpoint. Token-gated exactly like api/items.js.
// Backs /admin.html. No schema change — pr_subscribers + pr_feedback already
// exist; this just gives them a surface.
//
//   GET    /api/admin?t=…&view=subscribers      → list all subscribers
//   GET    /api/admin?t=…&view=feedback          → list feedback (open first)
//   POST   /api/admin?t=…  {email,name,categories}   → add / re-activate a subscriber
//   PATCH  /api/admin?t=…  {id,active}                → toggle a subscriber on/off
//   PATCH  /api/admin?t=…&resource=feedback {id,resolved} → triage feedback
//   DELETE /api/admin?t=…&id=N                        → remove a subscriber

import {
  allSubscribers, addSubscriber, setSubscriberActive, removeSubscriber,
  allFeedback, setFeedbackResolved,
} from '../lib/db.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  const token = req.query.t || req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.RADAR_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const resource = req.query.resource || req.query.view || 'subscribers';
  try {
    if (req.method === 'GET') {
      if (resource === 'feedback') return res.status(200).json(await allFeedback({ limit: Number(req.query.limit) || 200 }));
      return res.status(200).json(await allSubscribers());
    }

    if (req.method === 'POST') {
      const { email, name, categories } = req.body || {};
      if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
      // Accept categories as an array or a comma-separated string; empty → all.
      const cats = Array.isArray(categories)
        ? categories.map((c) => String(c).trim()).filter(Boolean)
        : (typeof categories === 'string' ? categories.split(',').map((c) => c.trim()).filter(Boolean) : []);
      const rows = await addSubscriber({ email, name, categories: cats });
      return res.status(200).json({ ok: true, subscriber: Array.isArray(rows) ? rows[0] : rows });
    }

    if (req.method === 'PATCH') {
      const { id, active, resolved } = req.body || {};
      if (id == null) return res.status(400).json({ error: 'id required' });
      if (resource === 'feedback') { await setFeedbackResolved(id, resolved); return res.status(204).end(); }
      await setSubscriberActive(id, active); return res.status(204).end();
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (id == null) return res.status(400).json({ error: 'id required' });
      await removeSubscriber(id); return res.status(204).end();
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('admin op failed', e.message);
    return res.status(500).json({ error: 'operation failed', detail: e.message });
  }
}
