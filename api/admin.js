// Admin endpoint — subscribers, feedback, users (RBAC allowlist) and the audit
// log. Admin-only. Backs /admin.html.
//
//   GET    /api/admin?view=subscribers|feedback|users|audit
//   POST   /api/admin                      {email,name,categories}  → add/reactivate subscriber
//   POST   /api/admin?resource=users       {email,role,name}        → add/reactivate a user
//   PATCH  /api/admin                      {id,active}              → toggle a subscriber
//   PATCH  /api/admin?resource=feedback    {id,resolved}            → triage feedback
//   PATCH  /api/admin?resource=users       {id,role?,active?,email?} → change a user
//   DELETE /api/admin?id=N                                          → remove a subscriber
//   DELETE /api/admin?resource=users&id=N&email=…                   → remove a user

import {
  allSubscribers, addSubscriber, setSubscriberActive, removeSubscriber,
  allFeedback, setFeedbackResolved,
  listUsers, upsertUser, setUserRole, setUserActive, removeUser,
  recentAudit, pendingRequests, countMissingAuthor,
} from '../lib/db.js';
import { requireRole, auditReq, adminSetPassword } from '../lib/auth.js';
import { sweepAuthors } from '../lib/author-backfill.js';

// The author-backfill sweep does up to ~40 parallel article fetches, so give the
// function room beyond the default; every other admin op returns in well under a second.
export const config = { maxDuration: 60 };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  const who = await requireRole(req, res, 'admin');
  if (!who) return;

  const resource = req.query.resource || req.query.view || 'subscribers';
  try {
    if (req.method === 'GET') {
      if (resource === 'feedback') return res.status(200).json(await allFeedback({ limit: Number(req.query.limit) || 200 }));
      if (resource === 'users') return res.status(200).json(await listUsers());
      if (resource === 'requests') return res.status(200).json(await pendingRequests());
      if (resource === 'audit') return res.status(200).json(await recentAudit({ limit: Number(req.query.limit) || 200 }));
      if (resource === 'author-gap') {   // backlog size for the Tools tab indicator
        const days = Math.max(1, Math.min(Number(req.query.days) || 7, 30));
        let missing = null;
        try { missing = await countMissingAuthor({ days }); } catch { missing = null; }
        return res.status(200).json({ missing, days });
      }
      return res.status(200).json(await allSubscribers());
    }

    if (req.method === 'POST') {
      if (resource === 'backfill-authors') {
        // One bounded sweep filling "—" authors on recent board cards. Read-mostly
        // (reads articles, writes bylines); no re-ingest, no emails. Repeat until
        // remaining is 0. Runs the same lib as the daily backfill + ?backfillAuthors.
        const result = await sweepAuthors({ days: req.body?.days, limit: req.body?.limit });
        await auditReq(req, who, 'authors.backfill', 'items', result);
        return res.status(200).json({ ok: true, ...result });
      }
      if (resource === 'users') {
        const { email, role, name } = req.body || {};
        if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
        const rows = await upsertUser({ email, role: role === 'admin' ? 'admin' : 'viewer', name, invited_by: who.actor });
        const user = Array.isArray(rows) ? rows[0] : rows;
        await auditReq(req, who, 'user.add', String(email).toLowerCase(), { role: role === 'admin' ? 'admin' : 'viewer' });
        return res.status(200).json({ ok: true, user });
      }
      const { email, name, categories } = req.body || {};
      if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
      const cats = Array.isArray(categories)
        ? categories.map((c) => String(c).trim()).filter(Boolean)
        : (typeof categories === 'string' ? categories.split(',').map((c) => c.trim()).filter(Boolean) : []);
      const rows = await addSubscriber({ email, name, categories: cats });
      await auditReq(req, who, 'subscriber.add', String(email).toLowerCase(), null);
      return res.status(200).json({ ok: true, subscriber: Array.isArray(rows) ? rows[0] : rows });
    }

    if (req.method === 'PATCH') {
      const { id, active, resolved, role, email, password } = req.body || {};
      if (id == null) return res.status(400).json({ error: 'id required' });

      if (resource === 'requests') {   // approve an access request
        const target = email && String(email).toLowerCase();
        await setUserActive(id, true);
        if (role === 'admin' || role === 'viewer') await setUserRole(id, role);
        await auditReq(req, who, 'access.approve', target || id, { role: role === 'admin' ? 'admin' : 'viewer' });
        return res.status(204).end();
      }

      if (resource === 'users') {
        // Admin password reset (no email). Sets/creates the Supabase password.
        if (typeof password === 'string' && password) {
          if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
          const target = email && String(email).toLowerCase();
          if (!target) return res.status(400).json({ error: 'email is required to set a password' });
          const ok = await adminSetPassword(target, password);
          if (!ok) return res.status(500).json({ error: 'could not set the password' });
          await auditReq(req, who, 'user.password', target, null);
          return res.status(204).end();
        }
        // Self-protection: an admin can't demote or deactivate their own account
        // (ADMIN_EMAILS remains the ultimate lock-out insurance regardless).
        const selfEmail = email && String(email).toLowerCase();
        const targetingSelf = selfEmail && who.email && selfEmail === who.email;
        if (targetingSelf && (role === 'viewer' || active === false)) {
          return res.status(400).json({ error: "you can't demote or deactivate your own account" });
        }
        if (role !== undefined) { await setUserRole(id, role); await auditReq(req, who, 'user.role', selfEmail || id, { role: role === 'admin' ? 'admin' : 'viewer' }); }
        if (active !== undefined) { await setUserActive(id, active); await auditReq(req, who, 'user.active', selfEmail || id, { active: !!active }); }
        return res.status(204).end();
      }
      if (resource === 'feedback') { await setFeedbackResolved(id, resolved); await auditReq(req, who, 'feedback.resolve', id, { resolved: !!resolved }); return res.status(204).end(); }
      await setSubscriberActive(id, active);
      await auditReq(req, who, 'subscriber.active', id, { active: !!active });
      return res.status(204).end();
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (id == null) return res.status(400).json({ error: 'id required' });
      if (resource === 'requests') {   // reject an access request
        const target = req.query.email && String(req.query.email).toLowerCase();
        await removeUser(id);
        await auditReq(req, who, 'access.reject', target || id, null);
        return res.status(204).end();
      }
      if (resource === 'users') {
        const selfEmail = req.query.email && String(req.query.email).toLowerCase();
        if (selfEmail && who.email && selfEmail === who.email) return res.status(400).json({ error: "you can't remove your own account" });
        await removeUser(id);
        await auditReq(req, who, 'user.remove', selfEmail || id, null);
        return res.status(204).end();
      }
      await removeSubscriber(id);
      await auditReq(req, who, 'subscriber.remove', id, null);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('admin op failed', e.message);
    return res.status(500).json({ error: 'operation failed', detail: e.message });
  }
}
