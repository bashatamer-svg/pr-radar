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
  recentAudit, pendingRequests, countMissingAuthor, itemsMissingAuthor, itemsForDupeScan, mergeDuplicateInto } from '../lib/db.js';
import { requireRole, auditReq, adminSetPassword } from '../lib/auth.js';
import { findDuplicateCandidates } from '../lib/dedupe.js';
import { sweepAuthors } from '../lib/author-backfill.js';
import { inspectAuthorPage, resetAuthorAiBudget } from '../lib/author.js';
import { isGoogleNews } from '../lib/resolve.js';
import { FEED_CANDIDATES } from '../lib/feed-candidates.js';
import { XMLParser } from 'fast-xml-parser';
import { sendWhatsAppUrgent, whatsappStatus } from '../lib/whatsapp.js';
import { renderUrgent, sendBulletin, urgentTier, isInstantAlert } from '../lib/email.js';

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
      if (resource === 'whatsapp-status') return res.status(200).json(whatsappStatus());
      if (resource === 'find-dupes') {
        // Read-only: two cards on the board that are really one story. Ingest
        // merges what it is SURE about; this surfaces the rest for a human,
        // because the judgement ("is this a second write-up or a follow-up?")
        // is the part a threshold cannot make.
        const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
        const min = Math.max(0.15, Math.min(Number(req.query.min) || 0.3, 0.9));
        const items = await itemsForDupeScan({ days });
        const pairs = findDuplicateCandidates(items, { min });
        return res.status(200).json({ days, min, scanned: items.length, pairs });
      }
      if (resource === 'probe-feeds') {
        // Verify candidate RSS URLs FROM PRODUCTION (the dev sandbox cannot
        // reach news hosts). Read-only: fetches each candidate, parses it, and
        // reports item count + whether it carries bylines. Nothing is stored —
        // a URL only becomes a live source after a human reads this and adds it
        // to lib/sources.js.
        const only = String(req.query.only || '').trim();
        const list = only ? FEED_CANDIDATES.filter((c) => c.id === only || c.kind === only) : FEED_CANDIDATES;
        const px = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const arrOf = (v) => (Array.isArray(v) ? v : v ? [v] : []);
        const UAS = [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        ];
        const fetchAs = async (url, ua, ms) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), ms);
          try {
            return await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: {
              'user-agent': ua,
              accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'ar-EG,ar;q=0.9,en;q=0.8',
            } });
          } finally { clearTimeout(t); }
        };
        const probe = async (url) => {
          let r = null;
          try { r = await fetchAs(url, UAS[0], 5000); } catch { r = null; }
          // a desktop-UA block is common on Egyptian sites; mobile often passes
          if (!r || !r.ok) { try { r = await fetchAs(url, UAS[1], 4000); } catch { r = null; } }
          try {
            if (!r) return { url, ok: false, status: 'timeout' };
            if (!r.ok) return { url, ok: false, status: r.status };
            const xml = px.parse(await r.text());
            const entries = arrOf(xml?.rss?.channel?.item).concat(arrOf(xml?.feed?.entry));
            if (!entries.length) return { url, ok: false, status: r.status, note: 'parsed, 0 items' };
            const withAuthor = entries.filter((e) => e['dc:creator'] || e.author).length;
            const first = entries[0];
            const title = String(first?.title?.['#text'] ?? first?.title ?? '').trim().slice(0, 70);
            return { url, ok: true, status: r.status, items: entries.length, bylines: withAuthor, sample: title };
          } catch (e) { return { url, ok: false, status: /abort/i.test(e.message) ? 'timeout' : 'error' }; }
        };
        // Bounded concurrency so ~80 fetches fit inside the function timeout.
        const out = [];
        const queue = [...list];
        await Promise.all(Array.from({ length: 10 }, async () => {
          for (;;) {
            const c = queue.shift();
            if (!c) return;
            const attempts = [];
            let win = null;
            for (const u of c.urls) {
              const r = await probe(u);
              attempts.push(r);
              if (r.ok) { win = r; break; }
            }
            out.push({ id: c.id, name: c.name, kind: c.kind, working: !!win, ...(win || {}), attempts });
          }
        }));
        out.sort((a, b) => (b.working - a.working) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
        const won = out.filter((r) => r.working);
        await auditReq(req, who, 'feeds.probe', 'candidates', {
          probed: out.length,
          working: won.length,
          // the useful part: which ones, where, and do they carry bylines
          feeds: won.map((r) => ({ id: r.id, url: r.url, items: r.items, bylines: r.bylines })),
          failed: out.filter((r) => !r.working).map((r) => r.id),
        });
        return res.status(200).json({ probed: out.length, working: out.filter((r) => r.working).length, rows: out });
      }

      if (resource === 'author-inspect') {
        // Evidence view for the authorless backlog: re-probe each card LIVE
        // (same fetch + extraction as the backfill, from production where
        // egress works) and return what the page actually contained — outcome,
        // opening text, raw candidates — so "no byline" is verifiable, not
        // taken on faith. Read-only: nothing is written.
        const days = Math.max(1, Math.min(Number(req.query.days) || 30, 45));
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 60));
        resetAuthorAiBudget();
        const stale = await itemsMissingAuthor({ days, limit });
        const rows = await Promise.all((stale || []).map(async (it) => {
          const url = [it.resolved_url, it.url].find((u) => u && !isGoogleNews(u)) || null;
          const probe = await inspectAuthorPage(url, it.source);
          return { id: it.id, source: it.source, headline: (it.headline || '').slice(0, 100), url, ...probe };
        }));
        return res.status(200).json({ days, count: rows.length, rows });
      }
      return res.status(200).json(await allSubscribers());
    }

    if (req.method === 'POST') {
      if (resource === 'merge-dupe') {
        // Fold one card into another: the duplicate's outlets become coverage on
        // the card we keep, then it is hidden everywhere. Audited, because it
        // changes what the board and the analytics count.
        const { keep, drop } = req.body || {};
        let result;
        try { result = await mergeDuplicateInto(keep, drop); }
        catch (e) { return res.status(400).json({ error: e.message }); }
        await auditReq(req, who, 'items.merge_duplicate', 'items', result);
        return res.status(200).json({ ok: true, ...result });
      }
      if (resource === 'backfill-authors') {
        // One bounded sweep filling "—" authors on recent board cards. Read-mostly
        // (reads articles, writes bylines); no re-ingest, no emails. Repeat until
        // remaining is 0. Runs the same lib as the daily backfill + ?backfillAuthors.
        const result = await sweepAuthors({ days: req.body?.days, limit: req.body?.limit });
        await auditReq(req, who, 'authors.backfill', 'items', result);
        return res.status(200).json({ ok: true, ...result });
      }
      if (resource === 'whatsapp-test') {
        // Deliver a sample urgent alert to the configured recipients so ops can
        // verify the number, opt-in, and template approval before going live.
        const sample = { brand: 'Vodafone', sentiment: 'negative', importance: 5,
          headline: 'Test alert from PR Radar — please ignore',
          pr_angle: 'Action · This is a WhatsApp delivery test' };
        const result = await sendWhatsAppUrgent(sample);
        await auditReq(req, who, 'whatsapp.test', who.actor, result);
        return res.status(200).json({ ok: true, ...result });
      }
      if (resource === 'alert-test') {
        // Prove the EMAIL alert path from production — tier wording, recipient
        // resolution and Resend — using the same renderUrgent + sendBulletin the
        // live alert uses. whatsapp-test covers the other channel and is blocked
        // on Meta's template approval, so until now the channel that actually
        // works could only be checked by unit test. The sandbox can't reach
        // Resend, so this has to run from production.
        // ALWAYS to the requesting admin: a delivery test must never page the
        // subscriber list, and there is no `to` override for the same reason.
        const to = who.email && EMAIL_RE.test(String(who.email)) ? String(who.email) : null;
        if (!to) return res.status(400).json({ error: 'sign in as a user to send a test alert — a service token has no address of its own' });
        const impact = [2, 4, 5].includes(Number(req.body?.impact)) ? Number(req.body.impact) : 5;
        const sample = {
          id: null, brand: 'Vodafone', sentiment: 'negative', importance: impact,
          headline: 'Test alert from PR Radar — please ignore',
          summary: 'A sample story used to verify instant-alert delivery. No such event occurred.',
          pr_angle: 'Action · This is an email delivery test',
          published_at: new Date().toISOString(), url: '',
        };
        // The sample must still trip the live rule, or the test proves nothing
        // about what production would actually send.
        if (!isInstantAlert(sample)) {
          return res.status(500).json({ error: 'the sample no longer trips isInstantAlert — the alert rule changed and this test would not reflect it' });
        }
        const tier = urgentTier(sample);
        const subject = `${tier.label} — ${sample.headline}`.slice(0, 140);
        let result;
        try {
          result = await sendBulletin(renderUrgent(sample, process.env.BOARD_URL || ''), subject, to);
        } catch (e) {
          await auditReq(req, who, 'alert.test', to, { impact, tier: tier.label, error: e.message });
          return res.status(502).json({ error: `send failed: ${e.message}` });
        }
        await auditReq(req, who, 'alert.test', to, { impact, tier: tier.label });
        return res.status(200).json({ ok: true, to, impact, tier: tier.label, id: result?.id || null });
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
