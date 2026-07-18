// Semantic dedup backstop.
//
// The lexical passes in api/radar.js (exact hash, then Jaccard token-overlap on
// the headline and on the classifier's summary) collapse obvious reposts. What
// they CANNOT catch is the same underlying event reported with different
// framing or in another language — a company's own announcement vs the
// regulator's wording, or an Arabic outlet vs an English one — because the two
// summaries share too few WORDS to clear the Jaccard bar, even though a human
// instantly sees one story.
//
// This pass finds the BORDERLINE pairs (moderate but sub-threshold overlap
// against a recently-stored summary or an earlier item this run) and asks a
// cheap model one question: is this the SAME event? Only confirmed same-event
// items are dropped. Fail-OPEN — any error keeps every item, because losing a
// real story is far worse than a duplicate card.
//
// Candidate gate (Jul 2026): the earlier gate (Jaccard >= 0.16 OR 3 shared
// distinctive unigrams) sat a hair ABOVE real same-event pairs — e.g. "Telecom
// Egypt launches a specialized data-centre entity" vs "Telecom Egypt
// establishes a wholly-owned data-centre subsidiary" scored Jaccard 0.158 with
// 2 shared strong tokens, so it never reached the model at all. The gate is now
// looser AND adds a bigram (word-pair) signal — shared PHRASES like "telecom
// egypt" / "data centre" are far more distinctive than shared single words, so
// two same-event summaries clear it even when their wording barely overlaps.
// Widening the gate only ever sends MORE pairs to the model; the model stays
// the precision gate and can never drop a non-duplicate.

const MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';

const LOW = 0.12;          // token-overlap floor to send a pair to the model
const HIGH = 0.5;          // at/above this the lexical summary pass already dropped it
const STRONG_MIN = 2;      // OR this many shared distinctive (len>=5) unigrams
const BIGRAM_MIN = 2;      // OR this many shared distinctive word-pairs
const MAX_PAIRS = 40;      // bound the single model call

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'as', 'by', 'with', 'its', 'egypt', 'egyptian', 'new', 'two', 'service', 'services']);
const tok = (s) =>
  new Set(String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
// Distinctive tokens — long enough to be a name / entity rather than filler.
const strongToks = (set) => new Set([...set].filter((w) => w.length >= 5));

// Bigrams (adjacent word-pairs). Uses a MINIMAL function-word stoplist — not the
// unigram STOP — so entity phrases like "telecom egypt" or "data centre" (whose
// second word can be a unigram-stopword) survive and become the shared signal.
const BI_STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'as', 'by', 'with', 'its', 'that', 'be', 'no', 'not']);
const bigrams = (s) => {
  const w = String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, ' ').split(/\s+/).filter((x) => x.length > 2 && !BI_STOP.has(x));
  const out = new Set();
  for (let i = 0; i < w.length - 1; i++) out.add(`${w[i]} ${w[i + 1]}`);
  return out;
};

const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const jac = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

async function sameEventBatch(pairs) {
  const list = pairs
    .map((p, i) => `${i}. EXISTING: ${p.existing}\n   NEW: ${p.item.summary}`)
    .join('\n');
  const system = `You de-duplicate a brand & reputation news feed tracking Egypt's four mobile operators (Vodafone, Orange, WE / Telecom Egypt, e& / Etisalat Misr). For each numbered pair you get an EXISTING item and a NEW item (one-sentence summaries). Decide whether the NEW item reports the SAME underlying event as the EXISTING one — just worded, framed, or translated differently.

SAME event (answer true) — different outlets/languages covering ONE happening, even when the framing differs:
- the same corporate action reported by two sources, e.g. "Telecom Egypt launches a specialized data-centre entity" vs "Telecom Egypt establishes a wholly-owned data-centre subsidiary" — one restructuring, two write-ups;
- the same product launch or market entry ("Amazon Leo launches in South Africa" vs "Herotel brings Amazon's Leo service to SA" — one launch, reported five ways);
- the same commercial deal / partnership named from either side (vendor, distributor, or local partner);
- the same regulator action / instrument / decision, whether the regulator or an affected operator is named — INCLUDING a regulator's official clarification or denial about the SAME specific measure, price change, or figure the other item is about;
- an Arabic-language and an English-language write-up of the same story;
- the same spectrum award, funding round, acquisition, or outage.
Shared distinctive specifics — the same named company, product, market, deal, instrument, or figure — are strong evidence it is one event.

NOT the same event (answer false): a DIFFERENT instrument or decision by the same regulator; a different company's separate move; a genuinely different deal, market, figure, or date; or only a shared broad topic ("data centres", "5G", "tariffs") with no shared specific. When there are no shared specifics and you are unsure, answer false.

Return ONLY a JSON array, one object per pair: [{"i": <index>, "same": true|false}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: list }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// items: this run's classified survivors (post lexical dedup).
// recentSummaries: raw summary strings of recently-stored items.
// Returns the items to KEEP (same array minus confirmed same-event reposts).
export async function semanticDedupe(items, recentSummaries = []) {
  const list = Array.isArray(items) ? items : [];
  if (!process.env.ANTHROPIC_API_KEY || list.length === 0) return list;

  // Pool of things to compare against: recent stored summaries, then each
  // earlier kept item this run (so two new reposts in one run also collapse).
  const pool = recentSummaries.filter(Boolean).map((s) => {
    const t = tok(s);
    return { summary: s, tokens: t, strong: strongToks(t), bi: bigrams(s) };
  });
  const pairs = [];
  for (const it of list) {
    if (!it || !it.summary || !it.is_relevant) continue;
    const t = tok(it.summary);
    const ts = strongToks(t);
    const tb = bigrams(it.summary);
    let best = null, bestScore = 0, bestJ = 0, bestSh = 0, bestBg = 0;
    for (const p of pool) {
      const j = jac(p.tokens, t);
      if (j >= HIGH) continue; // near-exact — the lexical pass in radar.js owns it
      const sh = shared(ts, p.strong);
      const bg = shared(tb, p.bi);
      // Blend token overlap, entity overlap, and phrase overlap for ranking.
      const score = Math.max(j, sh / (STRONG_MIN + 1), bg / (BIGRAM_MIN + 1));
      if (score > bestScore) { bestScore = score; best = p; bestJ = j; bestSh = sh; bestBg = bg; }
    }
    if (best && (bestJ >= LOW || bestSh >= STRONG_MIN || bestBg >= BIGRAM_MIN)) {
      pairs.push({ item: it, existing: best.summary, score: bestScore });
    }
    pool.push({ summary: it.summary, tokens: t, strong: ts, bi: tb });
  }

  if (!pairs.length) return list;
  // Strongest candidates first, then bound the single model call.
  pairs.sort((a, b) => b.score - a.score);
  if (pairs.length > MAX_PAIRS) pairs.length = MAX_PAIRS;

  try {
    const verdicts = await sameEventBatch(pairs);
    const dropHashes = new Set();
    for (const v of verdicts) {
      if (v && v.same && pairs[v.i]) dropHashes.add(pairs[v.i].item.hash);
    }
    if (dropHashes.size) console.log(`semantic dedupe: dropped ${dropHashes.size} same-event repost(s) of ${pairs.length} borderline pair(s)`);
    return list.filter((it) => !dropHashes.has(it.hash));
  } catch (e) {
    console.error('semantic dedupe failed — keeping all items', e.message);
    return list; // fail-open
  }
}
