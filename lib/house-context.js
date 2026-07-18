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
- Outages or scandals at a COMPETITOR that a) invite unfavourable comparison to Vodafone, or b) taint the whole sector.
- Labour disputes, layoffs, executive controversy, ad campaigns that misfire or offend.

What DRIVES POSITIVE sentiment (worth surfacing too):
- Network / coverage awards, speed-test wins, CSR and community programmes.
- Well-received campaigns, sponsorships landing well, product launches praised.
- Digital-inclusion, financial-inclusion (Vodafone Cash reach) wins.

Rule of use:
- Decide the SENTIMENT (negative / neutral / positive) toward the named brand FIRST, from the brand's own reputational standpoint (a competitor's success is negative-for-Vodafone context; a competitor's scandal is neutral-to-positive-for-Vodafone but flag sector spillover risk).
- Then write the reputational read: name the AUDIENCE affected and WHY it moves sentiment. Be concrete; do NOT invent numbers the item doesn't support.
- NEGATIVE items about Vodafone Egypt are the whole point of this tool — never under-rate them. When in doubt on a Vodafone-negative item, rate it UP.`;
