// House context for the PR Radar — the domain facts that turn a generic
// sentiment read into a concrete one. Injected into the classifier so the
// reputational angle names a real brand, product line or audience instead of
// hand-waving.
//
// SCOPE / SECURITY: keep this to PUBLIC market facts. The moment this file
// carries confidential internal figures, draft crisis responses, or unannounced
// campaigns, the tool stops being a public-news monitor — talk to comms
// leadership before it becomes anything else. Refine the approximations below
// against your own sources; they are seeded, not audited.

import { getHouseKnowledge } from './db.js';

// Living, admin-maintained knowledge doc (pr_context.house_knowledge),
// wrapped as an authoritative block appended after the static HOUSE_CONTEXT.
// Fail-open: returns '' if the DB is unreachable or empty, so a classification
// never breaks on it. This is what lets the PR team keep the context current
// (a new campaign, a live issue, a spokesperson change) WITHOUT a code change —
// edited at /context.html.
export async function livingKnowledgeBlock() {
  let txt = '';
  try { txt = (await getHouseKnowledge()) || ''; } catch { /* fail open */ }
  txt = txt.trim();
  if (!txt) return '';
  return `\n\nLIVING PR KNOWLEDGE — admin-maintained, current, and AUTHORITATIVE. Apply it exactly like the house context above. If an item concerns a live issue, campaign, spokesperson or holding line listed here, weigh it accordingly when judging sentiment and reputational risk:\n${txt}`;
}

/* ── STALENESS ─────────────────────────────────────────────────────────────
   The living-knowledge doc is injected into EVERY classification and marked
   AUTHORITATIVE, which is exactly why it decays badly: a line naming a live
   story ("the توليت song is a Vodafone ad's music") is correct for a fortnight
   and then quietly starts steering unrelated news. Nothing ever prompted
   anyone to prune it, and the doc is the one input to the classifier a human
   edits by hand.

   Two signals, neither needing a schema change:
     * the document's own updated_at (pr_context already stores it)
     * an optional `[YYYY-MM-DD]` at the start of a line, so an entry can carry
       its own age. Entries without one are not flagged — dating is a
       convention the doc adopts gradually, not a format it must satisfy. */

// A line that is stale enough to be worth a second look. Set off how long a
// news story stays live, not off a calendar month: Egyptian press cycles run
// one to three weeks, so a fact still in here at six is almost certainly done.
export const CONTEXT_STALE_DAYS = 45;
// The whole doc going untouched for longer than this means nobody is curating
// it, whatever the individual lines say.
export const CONTEXT_REVIEW_DAYS = 60;

const DATED_LINE = /^\s*[[(](\d{4}-\d{2}-\d{2})[\])]\s*(.+)$/;

/** Entries in the doc that carry a date and have passed CONTEXT_STALE_DAYS.
    → [{ date, text, ageDays }] — always an array, never throws. */
export function staleContextEntries(content, now = Date.now()) {
  const out = [];
  for (const raw of String(content || '').split(/\r?\n/)) {
    const m = raw.match(DATED_LINE);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) continue;
    const ageDays = Math.floor((now - t) / 864e5);
    if (ageDays > CONTEXT_STALE_DAYS) out.push({ date: m[1], text: m[2].slice(0, 90), ageDays });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/** What a caller passes as `content` when the READ ITSELF failed.
    `getHouseKnowledge()` returns '' for "no row", so an empty string cannot
    also mean "could not ask" — collapsing the two reported a healthy `ok`
    ("empty — only the static house context is injected") for a database the
    page could not reach, which is the one state a health check must never
    invent. Distinct sentinel, distinct answer. */
export const CONTEXT_UNAVAILABLE = Symbol('context-unavailable');

/** The doc's freshness as a Health check.
    → a check object. Never CRIT: a stale line makes the classifier slightly
    wrong about one story, which is a nudge to prune, not an outage. */
export function houseContextCheck({ content, updatedAt } = {}, now = Date.now()) {
  if (content === CONTEXT_UNAVAILABLE || updatedAt === undefined) {
    return { id: 'context', label: 'House knowledge', state: 'unknown',
      detail: 'could not read pr_context' };
  }
  const txt = String(content || '').trim();
  if (!txt) {
    // Empty is a perfectly good state — the static HOUSE_CONTEXT still applies.
    return { id: 'context', label: 'House knowledge', state: 'ok',
      detail: 'empty — only the static house context is injected' };
  }
  const stale = staleContextEntries(txt, now);
  const ageDays = updatedAt ? Math.floor((now - Date.parse(updatedAt)) / 864e5) : null;
  const lines = txt.split(/\r?\n/).filter((l) => l.trim()).length;

  if (stale.length) {
    return { id: 'context', label: 'House knowledge', state: 'warn',
      detail: `${stale.length} dated entr${stale.length === 1 ? 'y' : 'ies'} older than ${CONTEXT_STALE_DAYS} days — oldest: "${stale[0].text}" (${stale[0].ageDays}d)`,
      hint: 'This doc is injected into EVERY classification and marked authoritative, so a line whose story has ended keeps steering unrelated news. Prune it at /context.' };
  }
  if (ageDays != null && ageDays > CONTEXT_REVIEW_DAYS) {
    return { id: 'context', label: 'House knowledge', state: 'warn',
      detail: `${lines} line(s), untouched for ${ageDays} days`,
      hint: `Nothing here is dated, so its age cannot be judged line by line — start entries with [YYYY-MM-DD] and this check can name the ones that have expired. Review at /context.` };
  }
  return { id: 'context', label: 'House knowledge', state: 'ok',
    detail: `${lines} line(s)${ageDays != null ? `, last edited ${ageDays}d ago` : ''}` };
}

export const HOUSE_CONTEXT = `EGYPT MOBILE MARKET — PR & REPUTATION HOUSE CONTEXT (ground the reputational read in this; figures are public approximations):

Who we watch (the ONLY four brands in scope, all in Egypt):
- Vodafone Egypt — the home brand. Largest mobile operator (~40%+ share, on the order of ~45M subscribers). Majority-owned by Vodacom Group; ultimate parent Vodafone Group Plc. Its mobile-money product is Vodafone Cash.
- Orange Egypt — competitor. Mobile-money product Orange Money / Orange Cash.
- WE — competitor; the mobile brand of Telecom Egypt (the state-linked incumbent that also owns much of the fixed/wholesale infrastructure the others rely on).
- e& Egypt (Etisalat Misr; also written "e-and", "eand", formerly Etisalat Egypt) — competitor.

What "our brand" means here:
- The primary subject is VODAFONE EGYPT. Orange, WE and e& are tracked as COMPETITORS — their coverage is monitored for competitive/comparative sentiment and for issues that could spill over onto the whole sector (and thus Vodafone).

Audiences whose sentiment matters (name the affected one in the reputational read):
- Consumers / subscribers (prepaid majority, plus postpaid) — network quality, outages, pricing, billing, customer service, data caps.
- Vodafone Cash users and agents — wallet reliability, fees, fraud, KYC friction.
- Enterprise / B2B customers.
- Regulators & government (NTRA, CBE, MCIT) — as an audience whose perception matters, not as a compliance question.
- Employees & talent market — labour, leadership, culture stories.
- Investors / financial press — group ownership, results, market moves.

What DRIVES NEGATIVE sentiment (flag these hardest):
- Network outages, dropped-service or coverage complaints, slow data.
- Billing disputes, surprise charges, price rises framed as unfair.
- Vodafone Cash failures, fraud, or money-stuck-in-wallet stories.
- Poor customer service, viral consumer complaints, influencer pile-ons.
- Data-privacy or breach allegations, SIM-swap fraud.
- The same events at a COMPETITOR: their outage or scandal is negative for THEM (sentiment is never inverted). When it taints the whole sector, say so in the angle — that is where the Vodafone consequence goes.
- Labour disputes, layoffs, executive controversy, ad campaigns that misfire or offend.

What DRIVES POSITIVE sentiment (worth surfacing too):
- Network / coverage awards, speed-test wins, CSR and community programmes.
- Well-received campaigns, sponsorships landing well, product launches praised.
- Digital-inclusion, financial-inclusion (Vodafone Cash reach) wins.

Rule of use:
- Decide the SENTIMENT (negative / neutral / positive) toward the named brand FIRST, from THAT brand's own reputational standpoint, never inverted for Vodafone: a competitor's success is positive, a competitor's scandal is negative (flag sector spillover risk in the angle). The Vodafone consequence of a competitor story is carried by severity and pr_angle, not by this field.
- Then write the reputational read: name the AUDIENCE affected and WHY it moves sentiment. Be concrete; do NOT invent numbers the item doesn't support.
- NEGATIVE items about Vodafone Egypt are the whole point of this tool — never under-rate them. When in doubt on a Vodafone-negative item, rate it UP.`;
