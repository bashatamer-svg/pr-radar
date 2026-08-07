// Admin endpoint — subscribers, feedback, users (RBAC allowlist) and the audit
// log. Admin-only. Backs /admin.html.
//
//   GET    /api/admin?view=subscribers|feedback|users|requests|resets|audit
//   POST   /api/admin                      {email,name,categories}  → add/reactivate subscriber
//   POST   /api/admin?resource=users       {email,role,name,
//                                           subscribe?,notify?}      → provision a user:
//                                             allowlist row + starter password
//                                             (first name + 123) + daily-brief
//                                             subscription (default ON) + the
//                                             welcome email (default ON)
//   PATCH  /api/admin                      {id,active}              → toggle a subscriber
//   PATCH  /api/admin?resource=feedback    {id,resolved}            → triage feedback
//   PATCH  /api/admin?resource=users       {id,role?,active?,email?} → change a user
//   DELETE /api/admin?id=N                                          → remove a subscriber
//   DELETE /api/admin?resource=users&id=N&email=…                   → remove a user
//   DELETE /api/admin?resource=resets&id=N&email=…                  → dismiss a reset request

import {
  allSubscribers, addSubscriber, setSubscriberActive, removeSubscriber, getSubscriberByEmail,
  allFeedback, setFeedbackResolved,
  listUsers, setUserRole, setUserActive, removeUser,
  recentAudit, pendingRequests, countMissingAuthor, itemsMissingAuthor, itemsForDupeScan, mergeDuplicateInto,
  parkedItems, parkedItemCount, updateItemVerdict, updateSubscriber, whatsappSubscribers,
  itemsByIds, activeSubscribers, getStateTime, touchState,
  pendingResets, clearResetRequest, clearResetForEmail } from '../lib/db.js';
import { requireRole, auditReq, adminSetPassword, provisionUser, presetPasswordFor } from '../lib/auth.js';
import { findDuplicateCandidates } from '../lib/dedupe.js';
import { sweepAuthors } from '../lib/author-backfill.js';
import { classify } from '../lib/classify.js';
import { inspectAuthorPage, resetAuthorAiBudget } from '../lib/author.js';
import { isGoogleNews } from '../lib/resolve.js';
import { FEED_CANDIDATES } from '../lib/feed-candidates.js';
import { parseFeedXml, readCapped } from '../lib/xml.js';
import { sendWhatsAppUrgent, whatsappStatus, whatsappRecipients, whatsappConfigured } from '../lib/whatsapp.js';
import { renderUrgent, renderWelcome, sendBulletin, urgentTier, isInstantAlert } from '../lib/email.js';
import { postUrgentWebhook } from '../lib/notify.js';

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
      // Forgot-password queue. Fails soft to [] until the migration is applied,
      // so the Requests tab renders either way.
      if (resource === 'resets') return res.status(200).json(await pendingResets());
      if (resource === 'audit') return res.status(200).json(await recentAudit({ limit: Number(req.query.limit) || 200 }));
      if (resource === 'author-gap') {   // backlog size for the Tools tab indicator
        const days = Math.max(1, Math.min(Number(req.query.days) || 7, 30));
        let missing = null;
        try { missing = await countMissingAuthor({ days }); } catch { missing = null; }
        return res.status(200).json({ missing, days });
      }
      if (resource === 'whatsapp-status') return res.status(200).json(whatsappStatus());
      if (resource === 'whatsapp-check') {
        // Read-only: ask Meta what the configured credentials actually point at.
        // #132001 ("template does not exist in that language") is produced by
        // THREE different mistakes and the error cannot tell them apart:
        //   * the template is not approved yet
        //   * the language code differs (en vs en_US)
        //   * WHATSAPP_PHONE_ID belongs to a DIFFERENT WhatsApp Business
        //     Account from the one the template lives on — templates do not
        //     transfer between accounts
        // The sandbox has no route to graph.facebook.com, so this runs in prod.
        // The token is never echoed back.
        const token = process.env.WHATSAPP_TOKEN;
        const phoneId = process.env.WHATSAPP_PHONE_ID;
        const ver = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
        const cfg = whatsappStatus();
        const lang = process.env.WHATSAPP_TEMPLATE_LANG || 'en';
        if (!token || !phoneId) {
          return res.status(200).json({ config: { ...cfg, lang }, error: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_ID must both be set in the environment' });
        }
        const g = async (path) => {
          try {
            const r = await fetch(`https://graph.facebook.com/${ver}/${path}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = await r.json().catch(() => ({}));
            return r.ok ? { ok: true, body } : { ok: false, error: body?.error?.message || `HTTP ${r.status}`, code: body?.error?.code };
          } catch (e) { return { ok: false, error: e.message }; }
        };
        // 1. the sender number — proves the token works and the id is real
        const phoneRes = await g(`${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name,quality_rating`);
        // 1b. The NUMBER's own review state, fetched separately so that a Graph
        // version which does not expose these fields cannot take the whole
        // phone read down with it. name_status is the field that matters: an
        // approved TEMPLATE is only half the gate, and a display name still in
        // review fails every send with #131037 while everything else reads fine.
        const nameRes = await g(`${encodeURIComponent(phoneId)}?fields=name_status,code_verification_status,platform_type`);
        if (phoneRes.ok && nameRes.ok) Object.assign(phoneRes.body, nameRes.body);
        // 2. which account owns it. Not every Graph version exposes this field
        //    from the phone node, so WHATSAPP_WABA_ID can supply it instead.
        let wabaId = process.env.WHATSAPP_WABA_ID || null;
        let wabaSource = wabaId ? 'WHATSAPP_WABA_ID' : null;
        if (!wabaId) {
          const owner = await g(`${encodeURIComponent(phoneId)}?fields=whatsapp_business_account{id,name}`);
          if (owner.ok && owner.body?.whatsapp_business_account?.id) {
            wabaId = owner.body.whatsapp_business_account.id;
            wabaSource = 'resolved from the phone number';
          }
        }
        // 2b. Is Meta still deciding anything? account_review_status on the
        // WABA is the one remaining review that is NOT visible anywhere else on
        // this panel, and it answers the only question worth asking once the
        // template and the display name have both come back: is there a queue
        // we are in, or is the ball entirely in our court? Separate call, so an
        // unsupported field cannot break the WABA lookup.
        let accountReview = null;
        if (wabaId) {
          const rev = await g(`${encodeURIComponent(wabaId)}?fields=account_review_status`);
          if (rev.ok && rev.body?.account_review_status) accountReview = rev.body.account_review_status;
        }
        // 3. the templates that account actually has
        let templates = null, templatesError = null;
        if (wabaId) {
          const t = await g(`${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language,category&limit=100`);
          if (t.ok) templates = (t.body?.data || []).map((x) => ({ name: x.name, language: x.language, status: x.status, category: x.category }));
          else templatesError = t.error;
        } else {
          templatesError = 'could not work out which WhatsApp Business Account this number belongs to — set WHATSAPP_WABA_ID to check templates';
        }
        // 3b. WHO gets paged. BOTH lists, deduped — showing where each number
        // comes from, because "why isn't the person I just added on here?" is
        // the question this panel exists to answer.
        const envList = whatsappRecipients();
        const subList = await whatsappSubscribers().catch(() => []);
        const all = [...new Set([...envList, ...subList])];
        const mask = (ns) => ns.map((n) => (n.length <= 6 ? n : `${n.slice(0, 2)}${'•'.repeat(Math.max(2, n.length - 6))}${n.slice(-4)}`));

        // 4. does what we send actually exist there, in that language?
        // `state` separates "you have something to fix" from "Meta has not
        // finished reviewing yet". Collapsing the two told the admin to change
        // WHATSAPP_TEMPLATE_LANG when the language already matched and the only
        // thing missing was approval — sending them after a config problem that
        // did not exist.
        const byName = (templates || []).filter((t) => t.name === cfg.template);
        const sameLang = byName.filter((t) => t.language === lang);
        const exact = sameLang.find((t) => t.status === 'APPROVED') || null;
        let verdict, state;
        if (!templates) {
          verdict = 'could not read the template list'; state = 'error';
        } else if (exact) {
          verdict = `ready — "${cfg.template}" is APPROVED in "${lang}" on this account`; state = 'ready';
        } else if (!byName.length) {
          verdict = `no template named "${cfg.template}" on this account. Templates do not transfer between accounts — create it here, or point WHATSAPP_PHONE_ID at the account that has it.`;
          state = 'error';
        } else if (sameLang.length) {
          // Right name, right language, just not approved. Nothing to configure.
          const st = [...new Set(sameLang.map((t) => t.status))].join(', ');
          verdict = `waiting on Meta — "${cfg.template}" is on this account in "${lang}" and is ${st}. Nothing to fix: the language and account are already correct. Sends fail until Meta marks it APPROVED, usually within a few hours.`;
          state = 'waiting';
        } else {
          const opts = byName.map((t) => `${t.language} (${t.status})`).join(', ');
          verdict = `"${cfg.template}" is on this account but not in "${lang}". Available: ${opts}. Set WHATSAPP_TEMPLATE_LANG to the matching code.`;
          state = 'error';
        }
        // The template is only HALF the gate. Meta reviews the sending number's
        // DISPLAY NAME separately, and until that passes every send fails with
        // #131037 — which is exactly what happened on 4 Aug, with this panel
        // reading "ready" the whole time. A verdict that says ready while
        // nothing can send is worse than no verdict at all.
        // name_status has TWO passing values, not one. AVAILABLE_WITHOUT_REVIEW
        // means the name may be used without review — treating it as a blocker
        // told the operator to wait on something Meta had already cleared.
        const NAME_OK = ['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'];
        const nameStatus = phoneRes.ok ? phoneRes.body?.name_status : null;
        // A +1 555 number is the fictional range Meta auto-provisions as a TEST
        // number. It can only ever message a handful of pre-registered
        // recipients, so it will never serve a team — and no amount of template
        // or display-name approval changes that. Worth saying out loud, because
        // every other field on this panel reads perfectly healthy.
        const isTestNumber = /^\+1\s*555/.test(String(phoneRes.ok ? phoneRes.body?.display_phone_number || '' : ''));
        if (nameStatus && !NAME_OK.includes(nameStatus) && state !== 'error') {
          const who = phoneRes.body?.verified_name ? `"${phoneRes.body.verified_name}"` : 'this number';
          verdict = `the number cannot send yet — its display name ${who} is ${nameStatus}. Meta reviews the display name separately from the template, and until it passes every send fails with #131037. Nothing to configure; ${state === 'ready' ? 'the template is already approved' : 'the template is still in review too'}.`;
          state = 'waiting';
        } else if (isTestNumber && state === 'ready') {
          verdict = `${verdict} BUT the sender ${phoneRes.body.display_phone_number} is in the +1 555 range Meta auto-provisions as a TEST number: it can only message recipients pre-registered against it, which is why sends can still fail #131037 with everything above green. Register your own business number to reach the team.`;
          state = 'waiting';
        }
        return res.status(200).json({
          config: {
            ...cfg, lang, graphVersion: ver,
            recipients: mask(all),
            fromSubscribers: subList.length, fromEnv: envList.length,
          },
          phone: phoneRes.ok ? phoneRes.body : { error: phoneRes.error, code: phoneRes.code },
          waba: wabaId ? { id: wabaId, source: wabaSource, ...(accountReview ? { accountReview } : {}) } : null,
          templates, templatesError, verdict, state,
        });
      }
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
        // Feed AUTODISCOVERY. A site that publishes a feed almost always
        // declares it in the page head:
        //   <link rel="alternate" type="application/rss+xml" href="…">
        // That is the mechanism every feed reader uses, and asking the page
        // beats guessing suffixes at it — guessing is what left 28 candidates
        // disproven and the list empty. So whenever a candidate URL turns out
        // to be an HTML page, read what that page says its feed is.
        const discoverFeeds = (html, base) => {
          const out = [];
          for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
            if (!/rel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
            if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
            const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
            if (!href) continue;
            try { out.push(new URL(href[1], base).href); } catch { /* skip a malformed href */ }
          }
          return [...new Set(out)].slice(0, 3);   // bounded: a page can declare many
        };
        const probe = async (url) => {
          let r = null;
          try { r = await fetchAs(url, UAS[0], 5000); } catch { r = null; }
          // a desktop-UA block is common on Egyptian sites; mobile often passes
          if (!r || !r.ok) { try { r = await fetchAs(url, UAS[1], 4000); } catch { r = null; } }
          try {
            if (!r) return { url, ok: false, status: 'timeout' };
            if (!r.ok) return { url, ok: false, status: r.status };
            // Size-capped: a probe points at a URL nobody has verified, so it is
            // the likeliest place to meet a body that never ends.
            const body = await readCapped(r);
            const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
            let xml = null;
            try { xml = parseFeedXml(body); } catch { xml = null; }
            const entries = arrOf(xml?.rss?.channel?.item).concat(arrOf(xml?.feed?.entry));
            if (!entries.length) {
              // A 200 with no items is the ONLY informative failure here: the
              // host answered, so the URL shape is wrong rather than the outlet
              // being feedless. A bare "tried: 200" sent the last probe's reader
              // guessing another suffix; name what actually came back instead.
              const head = body.slice(0, 400).trim().toLowerCase();
              const roots = xml && typeof xml === 'object' ? Object.keys(xml).filter((k) => k !== '?xml') : [];
              const note = !body.trim() ? 'empty body'
                : /^<(!doctype html|html)/.test(head) ? 'HTML page, not a feed'
                : !xml ? 'not parseable as XML'
                : (xml.rss || xml.feed) ? 'feed with 0 items'
                : `XML, root <${roots[0] || '?'}>`;
              const discovered = note === 'HTML page, not a feed' ? discoverFeeds(body, url) : [];
              return { url, ok: false, status: r.status, note, type, ...(discovered.length ? { discovered } : {}) };
            }
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
            // Nothing staged worked, but a page may have TOLD us where its feed
            // is. Follow that before giving up — it is the difference between
            // "this outlet has no feed" and "we guessed the wrong path".
            if (!win) {
              const declared = [...new Set(attempts.flatMap((a) => a.discovered || []))]
                .filter((u) => !c.urls.includes(u));
              for (const u of declared) {
                const r = await probe(u);
                r.viaDiscovery = true;
                attempts.push(r);
                if (r.ok) { win = r; break; }
              }
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
          // the ones that ANSWERED but carried no feed — a wrong URL shape, not
          // a feedless outlet, and so the only group worth another attempt
          answered: out.filter((r) => !r.working && r.attempts.some((a) => a.note))
            .map((r) => ({ id: r.id, why: [...new Set(r.attempts.map((a) => a.note).filter(Boolean))].join(' · ') })),
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
          const probe = await inspectAuthorPage(url, it.source, { headline: it.headline });
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
        // Deliver a sample alert so ops can verify the number, the opt-in and
        // the template before going live. Scoped to WHATSAPP_TO ONLY — a test
        // that pages every subscriber is one nobody clicks twice, which is the
        // same reason the email test sends only to the signed-in admin.
        // Order matters: with the channel not configured at all, the honest
        // answer is the existing safe no-op — telling someone to set
        // WHATSAPP_TO when they have no token or number sends them to the
        // wrong problem. Only ask for it once the channel could actually send.
        const testTo = whatsappRecipients();
        if (whatsappConfigured() && !testTo.length) {
          return res.status(400).json({ error: 'set WHATSAPP_TO in the environment to choose who a test message goes to — the test deliberately does not page the subscriber list' });
        }
        const sample = { brand: 'Vodafone', sentiment: 'negative', importance: 5,
          headline: 'Test alert from PR Radar — please ignore',
          pr_angle: 'Action · This is a WhatsApp delivery test' };
        const result = await sendWhatsAppUrgent(sample, { to: testTo });
        await auditReq(req, who, 'whatsapp.test', who.actor, result);
        return res.status(200).json({ ok: true, ...result });
      }
      if (resource === 'reclassify-parked') {
        // Re-screen the rows the model never returned a verdict for. The Health
        // check's hint has always said these "can be re-run" — until now nothing
        // could actually do it, so a burst sat at CRITICAL until it aged out of
        // the 48h window.
        //
        // Same predicate as parkedItemCount, so what the check counts is exactly
        // what this picks up. Verdicts are written onto the EXISTING rows
        // (hash/url/seen_at untouched), so cards keep their identity and their
        // coverage instances. Anything the model still won't answer for stays
        // parked and is reported — never guessed at.
        const days = Math.max(1, Math.min(Number(req.body?.days) || 2, 7));
        const limit = Math.max(1, Math.min(Number(req.body?.limit) || 50, 100));
        const parked = await parkedItems({ days, limit });
        if (!parked.length) {
          return res.status(200).json({ ok: true, found: 0, resolved: 0, stillParked: 0, remaining: 0 });
        }
        const verdicts = await classify(parked.map((p) => ({
          hash: p.hash, headline: p.headline, url: p.url, source: p.source,
          author: p.author ?? null, published_at: p.published_at,
        })));
        let resolved = 0, stillParked = 0, kept = 0;
        for (let i = 0; i < parked.length; i++) {
          const v = verdicts[i];
          if (!v || v.category === 'unclassified') { stillParked++; continue; }
          try {
            await updateItemVerdict(parked[i].id, {
              brand: v.brand, sentiment: v.sentiment, country: v.country,
              category: v.category, summary: v.summary, pr_angle: v.pr_angle,
              importance: v.importance, confidence: v.confidence,
              is_relevant: v.is_relevant, deadline: v.deadline ?? null,
            });
            resolved++;
            if (v.is_relevant) kept++;
          } catch (e) {
            stillParked++;
            console.error('reclassify write failed', parked[i].id, e.message);
          }
        }
        let remaining = null;
        try { remaining = await parkedItemCount({ days }); } catch { remaining = null; }
        await auditReq(req, who, 'items.reclassify', 'items', { found: parked.length, resolved, kept, stillParked });
        return res.status(200).json({ ok: true, found: parked.length, resolved, kept, stillParked, remaining });
      }
      if (resource === 'send-alert') {
        // Fire the REAL urgent path for one stored card, after the fact.
        // Alerts normally fire at ingest only — so when a human corrects a
        // card INTO alert-qualifying territory (the Inas Ezzeddin case arrived
        // branded e& off an unnamed "شركة اتصالات" and was corrected to
        // Vodafone), the alert its readers should have had has already been
        // skipped, silently. This is the only path that can fire it late.
        // Same rule, renderer, recipients and channels as ingest — an alert
        // sent this way must be indistinguishable from one sent on time.
        const id = Number(req.body?.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'pass the card id' });
        const [item] = await itemsByIds([id]);
        if (!item) return res.status(404).json({ error: `no card #${id}` });
        if (!item.is_relevant) return res.status(400).json({ error: `card #${id} is hidden — unhide it before alerting on it` });
        // The GATE is the live rule, not the admin's judgement: a channel that
        // carries non-qualifying stories is a channel the team learns to ignore.
        if (!isInstantAlert(item)) {
          return res.status(400).json({ error: `card #${id} does not qualify: the rule is Impact 4-5, or a negative story about a tracked operator (this card is ${item.brand || 'no brand'} / ${item.sentiment || 'no sentiment'} / Impact ${item.importance || 0})` });
        }
        // Once per card. A second click must not page the team twice — but the
        // guard is per-card state, not a hard wall, so a genuine re-alert
        // (story escalated days later) stays possible via force.
        const KEY = `manual_alert_${id}`;
        const already = await getStateTime(KEY).catch(() => 0);
        if (already && !req.body?.force) {
          return res.status(409).json({ error: `an alert for card #${id} was already sent ${new Date(already).toISOString().slice(0, 16)}Z — pass force:true to send it again` });
        }
        // Recipient resolution copied from the ingest path (api/radar.js):
        // RADAR_TO wins when set; otherwise every active subscriber, category
        // filters deliberately ignored — same fail-safe direction, one
        // unexpected email beats a missed crisis.
        let alertTo = process.env.RADAR_TO || '';
        if (!alertTo.trim()) {
          const subs = await activeSubscribers().catch(() => []);
          alertTo = subs.map((s) => s.email).filter(Boolean).join(',');
        }
        if (!alertTo) return res.status(500).json({ error: 'no recipients: RADAR_TO is unset and there are no active subscribers' });
        const tier = urgentTier(item);
        const subject = `${tier.label} — ${item.headline}`.slice(0, 140);
        const boardUrl = process.env.BOARD_URL || '';
        let email;
        try { email = await sendBulletin(renderUrgent(item, boardUrl), subject, alertTo); }
        catch (e) {
          await auditReq(req, who, 'alert.manual', String(id), { tier: tier.label, error: e.message });
          return res.status(502).json({ error: `send failed: ${e.message}` });
        }
        // Same side channels as ingest, each fail-soft (no-op unless configured).
        await postUrgentWebhook(item, boardUrl);
        const wa = await sendWhatsAppUrgent(item).catch((e) => ({ sent: 0, failed: 0, error: e.message }));
        await touchState(KEY).catch(() => {});
        const result = { ok: true, id, tier: tier.label, emailed: email.sent || 0, emailFailed: email.failed || 0, whatsapp: wa };
        await auditReq(req, who, 'alert.manual', String(id), { tier: tier.label, emailed: result.emailed, re: !!already });
        return res.status(200).json(result);
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
        // Adding a person does THREE things, because an allowlist row on its own
        // left them stuck: they had to work out for themselves that they could
        // now "Create account", and an admin could not even do that (self-signup
        // refuses role=admin, by design).
        //   1. the allowlist row + a STARTER password (first name + 123)
        //   2. optionally the daily-brief list — `subscribe:false` to skip
        //   3. the welcome email carrying their own address and password
        // Each step is reported separately: an account that exists but whose
        // email failed needs a human to pass the password on, and that must not
        // read like a clean run.
        const { email, role, name, subscribe, notify, categories } = req.body || {};
        if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
        const addr = String(email).trim().toLowerCase();
        const person = name ? String(name).trim() : null;
        const wantRole = role === 'admin' ? 'admin' : 'viewer';
        const password = presetPasswordFor(person, addr);
        const { user, credentials, error: credError } = await provisionUser({
          email: addr, name: person, role: wantRole, invited_by: who.actor, password,
        });

        // Daily brief. Default ON: the reason to give someone the board is that
        // they want the coverage, and a reader who has to ask twice is a reader
        // who quietly gets nothing. `subscribe:false` opts out explicitly.
        // NEVER a blind addSubscriber: that upserts on email with every column
        // present, so it would wipe an existing subscriber's category filter and
        // WhatsApp number — the crisis number included. Look first, then add or
        // re-activate; leave a live row exactly as it is.
        let subscriber = 'skipped';
        if (subscribe !== false) {
          const cats = Array.isArray(categories)
            ? categories.map((c) => String(c).trim()).filter(Boolean)
            : (typeof categories === 'string' ? categories.split(',').map((c) => c.trim()).filter(Boolean) : []);
          try {
            const existing = await getSubscriberByEmail(addr);
            if (!existing) { await addSubscriber({ email: addr, name: person, categories: cats }); subscriber = 'added'; }
            else if (!existing.active) { await setSubscriberActive(existing.id, true); subscriber = 'reactivated'; }
            else subscriber = 'already';
          } catch (e) {
            // The ACCOUNT is already provisioned and usable; a mailing-list
            // failure must not undo it or fail the whole call.
            subscriber = 'failed';
            console.error('subscribe on user create failed', addr, e.message);
          }
        }
        const onBrief = ['added', 'reactivated', 'already'].includes(subscriber);

        // Welcome email — ONLY when we actually set the password. Someone who
        // already had one must never be sent a password they don't have: that
        // reads as "your password changed" and sends them to a login that fails.
        let emailed = null, emailError = null, bccd = false;
        if (notify !== false && credentials === 'created') {
          // BCC the admin so the send lands in their own inbox as the record of
          // who was told what — this response is gone the moment the page is
          // closed. forceBcc because RADAR_BCC_EXCLUDE is about the standing
          // monitor copy, not one asked for at send time.
          // TWO cases have no BCC, and both are reported rather than assumed:
          // the admin adding THEMSELVES (they are already the To), and a
          // token-driven call, which has no address of its own. The panel used
          // to claim "you are BCC'd" unconditionally — true for the ordinary
          // path, a lie for those two.
          const bcc = who.email && who.email !== addr ? who.email : null;
          bccd = !!bcc;
          try {
            await sendBulletin(
              renderWelcome({ name: person, email: addr, password, role: wantRole, boardUrl: process.env.BOARD_URL, support: who.email || null, subscribed: onBrief }),
              'Your PR Radar sign-in',
              addr,
              bcc ? { bcc, forceBcc: true } : {},
            );
            emailed = true;
          } catch (e) {
            emailed = false;
            emailError = e.message.slice(0, 160);
          }
        }
        // The password is deliberately NOT in the audit detail — an audit row is
        // long-lived storage and a credential does not belong in it. It rides
        // the response instead, to the admin who just asked for it.
        await auditReq(req, who, 'user.add', addr, { role: wantRole, credentials, subscriber, emailed });
        return res.status(200).json({
          ok: true, user, role: wantRole,
          credentials, credentialsError: credError || null,
          password: credentials === 'created' ? password : null,
          subscriber, emailed, emailError, bccd,
        });
      }
      const { email, name, categories, whatsapp } = req.body || {};
      if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
      // Reject a too-short number rather than storing something that will never
      // deliver: a silent non-delivery on the crisis channel is the failure this
      // whole area exists to prevent.
      const wa = String(whatsapp || '').replace(/[^\d]/g, '');
      if (whatsapp && wa.length < 8) return res.status(400).json({ error: 'WhatsApp number must include the country code, digits only (e.g. 201001234567)' });
      const cats = Array.isArray(categories)
        ? categories.map((c) => String(c).trim()).filter(Boolean)
        : (typeof categories === 'string' ? categories.split(',').map((c) => c.trim()).filter(Boolean) : []);
      const rows = await addSubscriber({ email, name, categories: cats, whatsapp: wa });
      await auditReq(req, who, 'subscriber.add', String(email).toLowerCase(), null);
      return res.status(200).json({ ok: true, subscriber: Array.isArray(rows) ? rows[0] : rows });
    }

    if (req.method === 'PATCH') {
      const { id, active, resolved, role, email, password, name, categories, whatsapp } = req.body || {};
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
          // Setting a password ANSWERS any outstanding request, so the queue
          // empties itself rather than needing a second "mark done" click.
          await clearResetForEmail(target);
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

      // Subscribers: `active` alone is the toggle; anything else is an edit.
      // Kept apart so the one-click pause stays a 204 and cannot be confused
      // with a field change that needs validating.
      const editing = name !== undefined || categories !== undefined || whatsapp !== undefined || email !== undefined;
      if (editing) {
        const patch = {};
        if (email !== undefined) {
          if (!EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'a valid email is required' });
          patch.email = email;
        }
        if (name !== undefined) patch.name = name;
        if (categories !== undefined) patch.categories = categories;
        if (whatsapp !== undefined) {
          const wa = String(whatsapp || '').replace(/[^\d]/g, '');
          // '' clears the number; anything present must be dialable, or the
          // crisis channel silently fails for that person at 3am.
          if (String(whatsapp || '').trim() && wa.length < 8) {
            return res.status(400).json({ error: 'WhatsApp number must include the country code, digits only (e.g. 201001234567)' });
          }
          patch.whatsapp = wa;
        }
        let rows;
        try {
          rows = await updateSubscriber(id, patch);
        } catch (e) {
          // The unique index on email is the likely failure, and "supabase 409"
          // tells the admin nothing about what to do.
          if (/duplicate|unique|409/i.test(e.message)) return res.status(409).json({ error: 'another subscriber already uses that email' });
          throw e;
        }
        await auditReq(req, who, 'subscriber.edit', id, patch);
        return res.status(200).json({ ok: true, subscriber: Array.isArray(rows) ? rows[0] : rows });
      }

      await setSubscriberActive(id, active);
      await auditReq(req, who, 'subscriber.active', id, { active: !!active });
      return res.status(204).end();
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (id == null) return res.status(400).json({ error: 'id required' });
      if (resource === 'resets') {   // dismiss a reset request, password unchanged
        const target = req.query.email && String(req.query.email).toLowerCase();
        await clearResetRequest(id);
        await auditReq(req, who, 'user.reset_dismissed', target || id, null);
        return res.status(204).end();
      }
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
