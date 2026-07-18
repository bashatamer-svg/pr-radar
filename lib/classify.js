// The LLM is a classifier here, not an agent. Fixed number of calls, strict
// schema, no tool use, no loop. Deterministic cost, debuggable failures.
//
// PR RADAR variant: this screens Egypt brand coverage for a PR / comms team.
// It judges SENTIMENT and REPUTATIONAL RISK, not regulatory materiality.

import { NEGATIVES } from './negatives.js';
import { POSITIVES } from './positives.js';
import { HOUSE_CONTEXT, livingKnowledgeBlock } from './house-context.js';

const MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const BATCH = 25;

// Bulletproof YYYY-MM-DD guard (kept for schema compatibility; PR items rarely
// carry a hard date, so null is the common, correct value).
export const cleanDate = (d) => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const dt = new Date(d + 'T00:00:00Z');
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d ? d : null;
};

const negBlock = NEGATIVES.length
  ? `\n\nHeadlines flagged by the team as noise on previous runs. Mark these AND\nnear-duplicates (same story, different wording) is_relevant: false:\n${NEGATIVES.map((h) => `- ${h}`).join('\n')}`
  : '';

const posBlock = POSITIVES.length
  ? `\n\nHeadlines the team explicitly marked VALUABLE on previous runs — this is what\na good hit looks like for them. Treat these AND near-duplicates as is_relevant:\ntrue and do not dismiss them as noise:\n${POSITIVES.map((h) => `- ${h}`).join('\n')}`
  : '';

const SYSTEM = `You screen Egyptian news headlines for the PR / communications team at Vodafone Egypt.

Their job is brand reputation. They track exactly FOUR mobile brands, all in Egypt:
  - Vodafone Egypt  (the HOME brand — the one they protect)
  - Orange Egypt    (competitor)
  - WE / Telecom Egypt (competitor)
  - e& Egypt / Etisalat Misr (competitor; also "e-and", "eand", formerly Etisalat Egypt)

SCOPE — be ruthless. An item is relevant ONLY if it is about one of those four
brands (or the Egyptian mobile market in a way that clearly touches them). If a
headline names none of them, or is about a different country's operations, or is
generic tech/world news, mark is_relevant: false and move on. Most headlines are
noise (handset launches with no brand angle, unrelated business news, sport,
opinion columns with no brand mention).

Each item is a numbered headline prefixed with its publishing outlet in
brackets, e.g. "[Daily News Egypt] Vodafone ...". Some also carry an "excerpt:"
line — a short summary from the source feed. When present, USE it: it is stronger
evidence than the headline for judging the brand, the sentiment and the
reputational angle. The excerpt can be noisy (Google News lists related coverage
there) — weigh it, don't quote it verbatim.

For each relevant item, identify:

1. brand — which of the four the item is PRIMARILY about: "Vodafone", "Orange",
   "WE", or "e&". If it genuinely spans the whole market with no single primary
   brand, use "market".

2. sentiment — the reputational direction FROM VODAFONE EGYPT'S STANDPOINT:
   - "negative" — bad for Vodafone's reputation. This includes:
       * anything that reflects badly on Vodafone Egypt directly (outages,
         billing disputes, price-rise backlash, Vodafone Cash failures/fraud,
         poor service, data-privacy or breach claims, viral complaints, labour
         or leadership controversy, a campaign that misfired);
       * a COMPETITOR's clear win or favourable comparison that makes Vodafone
         look worse (competitor wins a network award, launches a praised
         product, gains share).
   - "positive" — good for Vodafone's reputation. This includes:
       * Vodafone Egypt praised (award, well-received campaign, CSR win, strong
         results framed favourably);
       * a COMPETITOR's scandal or failure that leaves Vodafone looking better
         BY CONTRAST — but see sector-spillover below.
   - "neutral" — factual/announcement with no clear reputational charge either
     way (a routine appointment, an even-handed market note).

   SECTOR SPILLOVER: if a competitor's problem is really an industry-wide issue
   (a sector-wide outage, a data-privacy scandal that implicates all operators,
   a price row the public blames on "the mobile companies"), it is NEGATIVE for
   Vodafone too, because the public tars the whole sector. Say so in the angle.

3. severity — how much this could move public perception, 1..5 (this becomes
   "importance"). Weight it by (a) how negative and how directly it hits
   Vodafone, and (b) reach — a viral story, a front-page outlet, or a story
   running across many outlets scores higher than a single small mention.
     5 = a live reputational threat to Vodafone Egypt: a breaking scandal,
         a widespread outage, a fraud/breach story, a viral consumer pile-on,
         a crisis with national pickup. NEEDS COMMS ATTENTION TODAY.
     4 = a strongly negative Vodafone story with real pickup, OR a major
         competitor win that demands a comparative-messaging response.
     3 = a moderately negative or notable brand story worth the team knowing,
         OR a meaningful competitor move.
     2 = mild / routine brand coverage; positive or neutral colour; minor
         competitor note.
     1 = barely relevant brand mention; background.

   HARD RULE: a clearly NEGATIVE story about VODAFONE EGYPT is never below 3.
   When unsure on a Vodafone-negative item, round UP — a missed reputational
   risk is the costly failure here; a slightly over-rated one is cheap.

${HOUSE_CONTEXT}

Rules:
- summary must be YOUR OWN paraphrase, ONE sentence, never a quote from the
  headline. Describe the underlying EVENT canonically (what happened, to which
  brand), NOT the outlet's framing — two outlets reporting the same event must
  yield near-identical summaries, because that is what the de-duplicator matches
  on to group all the places a story was published.

- pr_angle — a compact 3-line reputational brief. Format EXACTLY as three lines
  separated by a single newline, each starting with its labelled marker
  (middle-dot separator, no markdown, no bullets):
    Read · <the reputational read: what this does to the brand and why>
    Audience · <whose perception moves — subscribers / Cash users / regulators / investors / employees / general public>
    Action · <what the comms team should do, at an intensity that MATCHES severity>

  The tone MUST match the severity you assigned. Decide severity FIRST, then
  write pr_angle at that level. Ladder:
    severity 5 — Action names an immediate comms step and owner: "Prepare a
      holding line and brief the comms lead today"; "Draft reactive Q&A, monitor
      pickup hourly." Read states the threat in the present tense; Audience is
      specific.
    severity 4 — Action is "Draft reactive lines / align messaging / prepare a
      response"; a real deliverable, not same-hour crisis.
    severity 3 — Action is "Monitor / brief the team / add to the tracker"; no
      external statement yet.
    severity 2 — Action is "Note — no action" / "Log as competitor colour";
      no owner, no task.
    severity 1 — Action is "—"; background only.

  HARD GATING:
  - "today / immediately / holding line / crisis / brief the lead now" and a
    named comms owner appear ONLY at severity 4-5.
  - At severity 1-2 the Action line must NOT contain an imperative task or a
    named owner.
  - Never fabricate a number (reach, %, EGP) the item doesn't support.
  - Never use empty filler ("may affect the brand", "worth watching") — but a
    light, low-demand tone at severity 1-2 is correct, not a defect.
  - If a line genuinely has no signal, emit it as "Read · —" etc. If the whole
    pr_angle would carry nothing, emit an empty string.

- confidence: 0-1, how sure you are from the headline (+excerpt) alone.
- deadline: PR items rarely carry a hard regulatory date — return null unless
  the item names a concrete calendar date the team must act on (e.g. a scheduled
  hearing, a campaign launch date). Never guess.
- If the headline alone is not enough to judge, say so via low confidence. Do
  not invent.${negBlock}${posBlock}

Return ONLY a JSON array. No prose, no markdown fences.
Each object: {"i": <index>, "is_relevant": bool, "brand": "Vodafone"|"Orange"|"WE"|"e&"|"market"|null,
"sentiment": "negative"|"neutral"|"positive"|null, "country": "Egypt",
"category": "network"|"pricing"|"customer_service"|"vodafone_cash"|"data_privacy"|"campaign"|"corporate"|"competitor"|"other",
"summary": str, "pr_angle": str,
"importance": 1-5, "confidence": 0-1, "deadline": "YYYY-MM-DD"|null}`;

async function callClaude(items, extraSystem = '') {
  const lines = items.map((it, i) => {
    const snip = it.snippet ? `\n   excerpt: ${it.snippet}` : '';
    return `${i}. [${it.source}] ${it.headline}${snip}`;
  }).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      // Cache the large static house-context prefix (re-sent every batch) so
      // repeat calls read it at ~10% of input price. See CLAUDE.md.
      system: [{ type: 'text', text: SYSTEM + extraSystem, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: lines }],
    }),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  return JSON.parse(text);
}

export async function classify(items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));

  // Fetch the admin-maintained living knowledge once and append to every
  // batch's system prompt. Fail-open inside livingKnowledgeBlock().
  const extraSystem = await livingKnowledgeBlock();

  const results = await Promise.all(chunks.map(async (chunk) => {
    try {
      return { chunk, verdicts: await callClaude(chunk, extraSystem) };
    } catch (e) {
      console.error('classify batch failed', e.message);
      return { chunk, verdicts: null };
    }
  }));

  const out = [];
  for (const { chunk, verdicts } of results) {
    if (!verdicts) {
      // A bad batch must not lose the run. Store unclassified, flag for review.
      // Emit the SAME field set as the success path — Supabase batch INSERT
      // rejects arrays whose objects have different key sets (PGRST102).
      for (const src of chunk) {
        out.push({
          hash: src.hash,
          headline: src.headline,
          url: src.url,
          source: src.source,
          author: src.author ?? null,
          published_at: src.published_at,
          brand: src.brand ?? null,
          sentiment: null,
          country: src.country ?? 'Egypt',
          category: 'other',
          summary: null,
          pr_angle: null,
          importance: 1,
          confidence: 0,
          is_relevant: false,
          deadline: null,
        });
      }
      continue;
    }
    for (const v of verdicts) {
      const src = chunk[v.i];
      if (!src) continue;
      out.push({
        hash: src.hash,
        headline: src.headline,
        url: src.url,
        source: src.source,
        author: src.author ?? null,
        published_at: src.published_at,
        brand: v.brand ?? src.brand ?? null,
        sentiment: v.sentiment || null,
        country: v.country || src.country || 'Egypt',
        category: v.category || 'other',
        summary: v.summary || null,
        pr_angle: v.pr_angle || null,
        importance: v.importance ?? 1,
        confidence: v.confidence ?? 0.5,
        is_relevant: !!v.is_relevant,
        deadline: cleanDate(v.deadline),
      });
    }
  }
  return out;
}
