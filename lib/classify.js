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

BRAND DISAMBIGUATION — each name means ONLY the Egyptian MOBILE OPERATOR, never a
look-alike that merely shares the word. In particular "Orange" = Orange Egypt the
mobile operator (أورنج / اورنج, Orange Money) ONLY — NOT a sports or social club
called Orange ("نادي أورانج" / "Orange Club"), the colour or the fruit, "Orange
County", or any other non-telecom entity. Likewise "WE" is Telecom Egypt's mobile
brand (المصرية للاتصالات / وي), never the plain English word "we"; "Vodafone" is
the operator (Vodafone Egypt / Vodafone Group / Vodafone Cash); "e&" / "Etisalat"
is the operator. If the apparent brand in an item is one of these look-alikes and
NOT the mobile operator, it is out of scope — mark is_relevant: false.

e& vs WE — DO NOT CONFUSE THESE TWO. They are different companies with similar
Arabic names. "اتصالات مصر" / "Etisalat Misr" / "إي آند مصر" / "e& Egypt" is the
brand **e&** (formerly Etisalat). "المصرية للاتصالات" / "Telecom Egypt" / "وي" is
the brand **WE**. They share the word "اتصالات" (telecom) but are different
operators: a story about "اتصالات مصر" — its ads, offers, network, results — is
brand "e&", NEVER "WE"; a story about "المصرية للاتصالات" is "WE", never "e&".

NON-EGYPT OPERATIONS — these same brands operate in OTHER countries (Orange is
huge in Jordan, Morocco and Tunisia; Etisalat across the Gulf; Vodafone group-
wide) and regional Arabic wires syndicate that coverage into an Egypt edition. A
story about a brand's operations OUTSIDE Egypt is OUT OF SCOPE — is_relevant:
false — even when it names the brand. Tell-tale signs it is NON-Egyptian (most
often Orange JORDAN): the outlet in brackets is a non-Egyptian agency (e.g.
"وكالة الانباء الاردنية" / Petra, "مدار الساعة", "عمون" / Ammon, a Gulf outlet),
or the item mentions "ولي العهد" (a Crown Prince — Egypt is a republic and has
none), Amman / عمّان, the Jordanian dinar, or distinctly Jordanian/Gulf names and
institutions. Only the EGYPTIAN operations of the four brands count. When the
country is genuinely unclear and there is no Egyptian signal, mark is_relevant:
false.

SCOPE — be ruthless. An item is relevant ONLY if it bears on one of those four
brands' REPUTATION or public perception. If a headline names none of them, or is
about a different country's operations, or is generic tech/world news, mark
is_relevant: false and move on. Most headlines are noise (handset launches with
no brand angle, unrelated business news, sport, opinion columns with no brand
mention).

NOT A REGULATORY MONITOR — this is a brand-reputation tool, not a policy tracker.
Mark is_relevant: false for regulatory, licensing, spectrum, numbering, and
government / NTRA / MCIT / CBE policy or process news — new rules, mandates,
consultations, official initiatives, regulator statistics, digital-inclusion or
child-protection programmes, sector-wide obligations — UNLESS the item directly
names one of the four brands AND materially moves THAT brand's public reputation
(e.g. "NTRA fines Vodafone over an outage"). A regulator announcement, a policy
initiative, or a sector rule that does not single out one of the four brands is
noise, even when it concerns the mobile market. (Reputation EVENTS — outages,
billing backlash, fraud, viral complaints — stay in scope even when sector-wide,
per sector-spillover below; a rule or a government programme by itself does not.)

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

- reason: ONLY when is_relevant is false — ONE short clause naming the rule that
  excluded it (e.g. "Orange Jordan, not Egypt", "regulatory news naming no
  brand", "look-alike, not the operator"). null when relevant. This powers the
  coverage diagnostic, so be specific, not generic.
Return ONLY a JSON array. No prose, no markdown fences.
Each object: {"i": <index>, "is_relevant": bool, "brand": "Vodafone"|"Orange"|"WE"|"e&"|"market"|null,
"sentiment": "negative"|"neutral"|"positive"|null, "country": "Egypt",
"category": "network"|"pricing"|"customer_service"|"vodafone_cash"|"data_privacy"|"campaign"|"corporate"|"competitor"|"other",
"summary": str, "pr_angle": str,
"importance": 1-5, "confidence": 0-1, "deadline": "YYYY-MM-DD"|null, "reason": str|null}`;

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

  // Models occasionally trail an explanation after the JSON array or wrap it in
  // prose ("Unexpected non-whitespace character after JSON"). Parse clean first,
  // then salvage the outermost [ … ] span before giving up on the batch.
  return parseArray(text);
}

// Robust JSON-array parse: clean parse first, then salvage from the first '[' to
// the last ']'. Throws only when there is no array at all (the caller then stores
// that batch unclassified — nothing is silently lost).
function parseArray(text) {
  try { return JSON.parse(text); } catch { /* fall through to salvage */ }
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
  throw new Error(`no JSON array in model output: ${text.slice(0, 80)}`);
}

// Build a pr_items record from a source item + the model's verdict. Both this
// and unclassifiedRecord() MUST emit the identical key set — a Supabase batch
// INSERT rejects arrays whose objects have different keys wholesale (PGRST102).
function classifiedRecord(src, v) {
  return {
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
    // In-memory only — the ?debug=1 coverage trace reads it; api/radar.js strips
    // it before insertItems (not a pr_items column).
    reason: v.reason || null,
  };
}

// Fallback for an item the model never returned a verdict for (a batch that
// stayed unparseable even after splitting, or an index the model omitted).
// Marked category:'unclassified' + confidence:0 and is_relevant:false so it
// never spams the board, but is greppable in the DB and counted in the logs —
// unlike the old path, which buried such items indistinguishably as 'other'.
function unclassifiedRecord(src) {
  return {
    hash: src.hash,
    headline: src.headline,
    url: src.url,
    source: src.source,
    author: src.author ?? null,
    published_at: src.published_at,
    brand: src.brand ?? null,
    sentiment: null,
    country: src.country ?? 'Egypt',
    category: 'unclassified',
    summary: null,
    pr_angle: null,
    importance: 1,
    confidence: 0,
    is_relevant: false,
    deadline: null,
    reason: 'unclassified (model returned no verdict for this item)',
  };
}

// Classify one chunk, returning an array aligned 1:1 with `chunk` — each slot is
// the item's verdict object, or null if the model didn't return one for it.
// On a hard failure (unparseable JSON, network) the chunk is SPLIT IN HALF and
// each half retried, recursively down to a single item. A single poison item
// then isolates to just itself instead of dropping all 25 stories in its batch.
async function classifyChunk(chunk, extraSystem) {
  try {
    const verdicts = await callClaude(chunk, extraSystem);
    const byIndex = new Map();
    for (const v of verdicts || []) {
      if (v && Number.isInteger(v.i)) byIndex.set(v.i, v);
    }
    return chunk.map((_, i) => byIndex.get(i) ?? null);
  } catch (e) {
    if (chunk.length <= 1) {
      console.error('classify item failed after retries:', (chunk[0]?.headline || '').slice(0, 80), '—', e.message);
      return [null];
    }
    const mid = Math.ceil(chunk.length / 2);
    console.warn(`classify batch of ${chunk.length} failed (${e.message}); splitting ${mid}/${chunk.length - mid} and retrying`);
    const [a, b] = await Promise.all([
      classifyChunk(chunk.slice(0, mid), extraSystem),
      classifyChunk(chunk.slice(mid), extraSystem),
    ]);
    return [...a, ...b];
  }
}

export async function classify(items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));

  // Fetch the admin-maintained living knowledge once and append to every
  // batch's system prompt. Fail-open inside livingKnowledgeBlock().
  const extraSystem = await livingKnowledgeBlock();

  const perChunk = await Promise.all(chunks.map((chunk) => classifyChunk(chunk, extraSystem)));

  const out = [];
  let unclassified = 0;
  chunks.forEach((chunk, ci) => {
    const verdicts = perChunk[ci];
    chunk.forEach((src, i) => {
      const v = verdicts[i];
      if (v) {
        out.push(classifiedRecord(src, v));
      } else {
        unclassified++;
        out.push(unclassifiedRecord(src));
      }
    });
  });

  if (unclassified) {
    console.warn(`classify: ${unclassified}/${items.length} item(s) unclassified after retries — stored is_relevant:false, category:'unclassified'`);
  }
  return out;
}
