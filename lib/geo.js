// AI answer-engine (GEO) monitoring — "what do the AI answer engines say when
// someone asks about Vodafone Egypt?" More and more people ask ChatGPT /
// Perplexity / Gemini instead of Googling, so a wrong or hostile AI answer is a
// reputational surface the RSS pipeline never sees.
//
// This is its OWN source, deliberately separate from the news pipeline:
//   1. prompt a small, fixed set of probe questions at each enabled engine,
//   2. have the existing classifier model AUDIT each answer against the house
//      facts (lib/house-context.js) for factual DRIFT and negative FRAMING,
//   3. return findings; the caller flags the bad ones.
//
// OFF BY DEFAULT + COST-BOUNDED: nothing runs unless GEO_ENABLED=1, each engine
// is dormant until ITS api key is set, and probes×engines are hard-capped so a
// run can never fan out into a surprise bill. Every network call is fail-soft.

import { HOUSE_CONTEXT } from './house-context.js';

const TIMEOUT_MS = 20000;
const EVAL_MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';

async function fetchT(url, opts, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// The probe questions — the things a subscriber, journalist or investor might
// actually ask an answer engine. Small on purpose (cost). Override the count
// with GEO_MAX_PROBES; the list itself is the ceiling.
const PROBES = [
  'What is Vodafone Egypt and how reliable is its mobile network?',
  'What are the most common customer complaints about Vodafone Egypt and Vodafone Cash?',
  'Who owns Vodafone Egypt and what is its position in the Egyptian mobile market?',
  'Is Vodafone Cash safe and trustworthy for mobile payments in Egypt?',
];

// ── Engines. Each is dormant until its key is set; ask() returns the answer
// text or null (fail-soft). Models are env-overridable since vendor model ids
// drift. Order also sets the cost priority (MAX_ENGINES caps how many run).
const ENGINES = [
  {
    id: 'perplexity',
    name: 'Perplexity',
    // A true answer engine (retrieves + cites), the closest analog to what a
    // user gets — so it's first.
    enabled: () => !!process.env.PERPLEXITY_API_KEY,
    ask: async (q) => {
      const res = await fetchT('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
        body: JSON.stringify({ model: process.env.GEO_PERPLEXITY_MODEL || 'sonar', messages: [{ role: 'user', content: q }] }),
      });
      if (!res.ok) throw new Error(`perplexity ${res.status}`);
      const d = await res.json();
      return d.choices?.[0]?.message?.content || null;
    },
  },
  {
    id: 'openai',
    name: 'ChatGPT (OpenAI)',
    enabled: () => !!process.env.OPENAI_API_KEY,
    ask: async (q) => {
      const res = await fetchT('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: process.env.GEO_OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: q }] }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const d = await res.json();
      return d.choices?.[0]?.message?.content || null;
    },
  },
  {
    id: 'gemini',
    name: 'Gemini (Google)',
    enabled: () => !!process.env.GEMINI_API_KEY,
    ask: async (q) => {
      const model = process.env.GEO_GEMINI_MODEL || 'gemini-2.0-flash';
      const res = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: q }] }] }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const d = await res.json();
      return d.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || null;
    },
  },
];

// Audit one answer against the house facts. Returns a verdict object or null on
// any failure (no ANTHROPIC key, parse error) — a null verdict is never flagged.
async function auditAnswer(question, answer) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const system = `You audit how AI answer engines describe VODAFONE EGYPT, to protect its reputation. You are given KNOWN FACTS (authoritative) and an answer engine's ANSWER to a question. Judge ONLY the answer.

KNOWN FACTS:
${HOUSE_CONTEXT}

Return ONLY a JSON object:
{"sentiment":"negative|neutral|positive","negative_framing":true|false,"factual_issues":["short phrase per concrete factual error or drift vs the known facts"],"severity":1-5,"note":"one sentence for the comms team"}

Rules:
- negative_framing=true when the answer leans critical/unflattering toward Vodafone Egypt (dwelling on complaints, outages, distrust) beyond a neutral summary.
- factual_issues: ONLY concrete, checkable errors (wrong owner, wrong market position, invented figures, confusing Vodafone Egypt with another market). An opinion is not a factual error. Empty array if none.
- severity: 5 = damaging false claim stated as fact; 3 = notable negative framing or a real error; 1 = clean/accurate. Base it on reputational risk to Vodafone Egypt.`;

  const res = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: `QUESTION: ${question}\n\nANSWER:\n${answer}` }] }),
  });
  if (!res.ok) throw new Error(`audit ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
  let v;
  try { v = JSON.parse(text); }
  catch { const s = text.indexOf('{'), e = text.lastIndexOf('}'); if (s === -1 || e <= s) return null; v = JSON.parse(text.slice(s, e + 1)); }
  return {
    sentiment: v.sentiment === 'negative' || v.sentiment === 'positive' ? v.sentiment : 'neutral',
    negative_framing: !!v.negative_framing,
    factual_issues: Array.isArray(v.factual_issues) ? v.factual_issues.filter(Boolean).slice(0, 6) : [],
    severity: Math.max(1, Math.min(5, Number(v.severity) || 1)),
    note: typeof v.note === 'string' ? v.note.slice(0, 300) : '',
  };
}

const isFlaggedFinding = (f) => !!f.verdict && (f.verdict.negative_framing || f.verdict.factual_issues.length > 0 || f.verdict.sentiment === 'negative');

// Run the GEO check. Fully gated + bounded. Returns
// { enabled, engines, checked, flagged, findings, note }.
export async function runGeoCheck(opts = {}) {
  if (process.env.GEO_ENABLED !== '1') return { enabled: false, engines: [], checked: 0, flagged: 0, findings: [] };

  const maxEngines = Math.max(1, Math.min(Number(process.env.GEO_MAX_ENGINES) || opts.maxEngines || 3, ENGINES.length));
  const maxProbes = Math.max(1, Math.min(Number(process.env.GEO_MAX_PROBES) || opts.maxProbes || PROBES.length, PROBES.length));
  const engines = ENGINES.filter((e) => e.enabled()).slice(0, maxEngines);
  const probes = PROBES.slice(0, maxProbes);
  if (!engines.length) {
    return { enabled: true, engines: [], checked: 0, flagged: 0, findings: [], note: 'no engine API keys set — feature idle' };
  }

  const findings = [];
  for (const engine of engines) {
    for (const q of probes) {
      let answer = null;
      try { answer = await engine.ask(q); }
      catch (e) { console.error(`geo: ${engine.id} ask failed`, e.message); }
      if (!answer) continue;
      let verdict = null;
      try { verdict = await auditAnswer(q, answer); }
      catch (e) { console.error('geo: audit failed', e.message); }
      findings.push({ engine: engine.name, engineId: engine.id, question: q, answer: String(answer).slice(0, 1200), verdict });
    }
  }
  findings.sort((a, b) => (b.verdict?.severity || 0) - (a.verdict?.severity || 0));
  const flags = findings.filter(isFlaggedFinding);
  return {
    enabled: true,
    engines: engines.map((e) => e.name),
    checked: findings.length,
    flagged: flags.length,
    findings,
  };
}

export { isFlaggedFinding };

/* ============================================================
   Render — compact GEO alert email (opt-in), reusing THEME
   ============================================================ */
import { THEME as T, esc } from './email.js';

export function renderGeoEmail(result, boardUrl) {
  const flags = result.findings.filter(isFlaggedFinding);
  const list = (flags.length ? flags : result.findings).slice(0, 12);
  const timeCairo = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
  const sevColor = (s) => (s >= 5 ? T.RED : s >= 3 ? '#f27100' : T.MUTED_2);

  const block = (f) => {
    const v = f.verdict || {};
    const issues = (v.factual_issues || []).map((i) => `<li style="margin:2px 0;">${esc(i)}</li>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;"><tr>
      <td width="4" bgcolor="${sevColor(v.severity)}" style="width:4px;background:${sevColor(v.severity)};font-size:0;line-height:0;">&nbsp;</td>
      <td bgcolor="${T.CARD}" style="background:${T.CARD};border:1px solid ${T.HAIRLINE_2};border-left:0;padding:12px 14px;font-family:${T.FONT};">
        <div style="font-size:11px;color:${T.MUTED_2};">
          <strong style="color:${T.INK};">${esc(f.engine)}</strong>${v.severity ? ` · sev ${v.severity}` : ''}${v.negative_framing ? ` · <span style="color:${T.RED_DEEP};font-weight:bold;">negative framing</span>` : ''}${(v.factual_issues || []).length ? ` · <span style="color:${T.RED_DEEP};font-weight:bold;">factual drift</span>` : ''}
        </div>
        <div dir="auto" style="font-size:13px;font-weight:bold;color:${T.INK};padding-top:5px;">${esc(f.question)}</div>
        ${v.note ? `<div style="font-size:12.5px;color:${T.INK_SOFT};padding-top:5px;">${esc(v.note)}</div>` : ''}
        ${issues ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12px;color:${T.RED_DEEP};">${issues}</ul>` : ''}
        <div dir="auto" style="font-size:11.5px;color:${T.MUTED};padding-top:7px;border-top:1px solid ${T.HAIRLINE_2};margin-top:8px;">${esc(String(f.answer).slice(0, 320))}${f.answer.length > 320 ? '…' : ''}</div>
      </td></tr></table>`;
  };

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>GEO — PR Radar</title>
<style>body{margin:0;padding:0;background:${T.CANVAS}} table{border-collapse:collapse!important} a{color:${T.RED}}
@media only screen and (max-width:620px){.container{width:100%!important}.px{padding-left:16px!important;padding-right:16px!important}}</style>
</head><body style="margin:0;padding:0;background:${T.CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.CANVAS};"><tr><td align="center">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${T.PAPER};">
  <tr><td bgcolor="${T.RED}" style="background:${T.RED};padding:18px 22px 14px;" class="px">
    <div style="font-family:${T.FONT};font-size:19px;font-weight:bold;color:#ffffff;">AI Answer-Engine Watch</div>
    <div style="font-family:${T.FONT};font-size:10px;color:#ffd0d0;letter-spacing:1.2px;padding-top:4px;">GEO · ${esc(result.engines.join(', ') || '—')} · ${timeCairo} CAIRO</div>
  </td></tr>
  <tr><td style="padding:14px 22px 4px;" class="px">
    <div style="font-family:${T.FONT};font-size:12.5px;color:${T.INK_SOFT};padding-bottom:4px;">
      ${result.flagged} of ${result.checked} answer${result.checked === 1 ? '' : 's'} flagged for factual drift or negative framing about Vodafone Egypt.
    </div>
    ${list.map(block).join('') || `<div style="font-family:${T.FONT};font-size:13px;color:${T.MUTED};padding:12px 0;">Nothing flagged — the engines described Vodafone Egypt cleanly.</div>`}
  </td></tr>
  <tr><td bgcolor="${T.PAPER_2}" style="background:${T.PAPER_2};padding:16px 22px 22px;font-family:${T.FONT};" class="px">
    <div style="font-size:11px;line-height:1.6;color:${T.MUTED_2};">Probes major AI answer engines about Vodafone Egypt and audits each answer against the house facts. Off unless enabled; cost-bounded. Built for the PR &amp; Communications team · Vodafone Egypt.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}
