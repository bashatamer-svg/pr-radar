// AI byline fallback: fires ONLY when the deterministic cascade finds nothing,
// respects AUTHOR_AI=0, and never fabricates. Mocks page fetch + Anthropic.
import assert from 'node:assert';

process.env.ANTHROPIC_API_KEY = 'ak';
delete process.env.AUTHOR_AI;

let pageHtml = '';
let anthropicCalls = 0;
let anthropicReturn = '{"author": "Riham Ali"}';
let articleAttempts = 0;
let statuses = null;   // e.g. [403, 200] to script successive article-fetch statuses; null → always 200

let lastAiText = '';   // what the model was actually given to read

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    anthropicCalls++;
    try { lastAiText = JSON.parse(opts.body).messages[0].content; } catch { lastAiText = ''; }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: anthropicReturn }] }) };
  }
  // article page fetch (status scriptable to exercise the retry)
  articleAttempts++;
  const st = statuses ? (statuses[articleAttempts - 1] ?? statuses[statuses.length - 1]) : 200;
  if (st !== 200) return { ok: false, status: st, text: async () => '', json: async () => ({}) };
  return { ok: true, status: 200, text: async () => pageHtml };
};

const { fetchAuthor, resetAuthorAiBudget } = await import(new URL('..', import.meta.url).pathname + '/lib/author.js');

// 1. <meta name="author"> hit → deterministic, NO Anthropic call.
anthropicCalls = 0;
pageHtml = '<html><head><meta name="author" content="Sara Adel"></head><body><h1>Story</h1></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/a'), 'Sara Adel', 'meta author resolved');
assert.strictEqual(anthropicCalls, 0, 'meta hit did NOT call the AI fallback');

// 2. Byline as plain text under the headline (no meta/JSON-LD/byline markup) →
//    exactly ONE Anthropic call, returns the person.
anthropicCalls = 0;
anthropicReturn = '{"author": "Riham Ali"}';
pageHtml = '<html><body><h1>Fintech news</h1><p>Finteck Gate: Riham Ali</p><p>Cairo — the company issued a detailed statement on Sunday describing the incident, its causes, and the remediation steps now under way across the network.</p></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/b'), 'Riham Ali', 'AI fallback extracted the plain-text byline');
assert.strictEqual(anthropicCalls, 1, 'plain-text byline → exactly one AI call');

// 3. No byline anywhere → model returns null → fetchAuthor null (one AI call, no fabrication).
anthropicCalls = 0;
anthropicReturn = '{"author": null}';
pageHtml = '<html><body><h1>Wire copy</h1><p>Cairo — the company issued a detailed statement on Sunday describing the incident, its causes, and the remediation steps now under way across the network.</p></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/c'), null, 'no byline → null');
assert.strictEqual(anthropicCalls, 1, 'AI fallback fired once, returned null (no fabrication)');

// 4. AUTHOR_AI=0 kill switch → fallback never fires even when the cascade is empty.
process.env.AUTHOR_AI = '0';
anthropicCalls = 0;
pageHtml = '<html><body><h1>Fintech news</h1><p>Finteck Gate: Riham Ali</p></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/d'), null, 'kill switch → no author');
assert.strictEqual(anthropicCalls, 0, 'AUTHOR_AI=0 → AI fallback never called');
delete process.env.AUTHOR_AI;

// 5. AI returns an outlet-ish / junk name → cleanName still guards (desk word → null).
anthropicCalls = 0;
anthropicReturn = '{"author": "News Desk"}';
pageHtml = '<html><body><h1>x</h1><p>Cairo — the company issued a detailed statement on Sunday describing the incident, its causes, and the remediation steps now under way across the network.</p></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/e'), null, 'a desk name from the model is rejected by cleanName');

// 6. The model reads the ARTICLE, not the site chrome: with >4k chars of nav
//    links before the story, the byline next to the headline must still land
//    inside the text the model is given (cut from <h1>/<article> onward).
anthropicCalls = 0;
anthropicReturn = '{"author": "Riham Ali"}';
const nav = Array.from({ length: 300 }, (_, i) => `<a href="/cat${i}">قسم الأخبار رقم ${i}</a>`).join(' ');
pageHtml = `<html><body><nav>${nav}</nav><h1>Fintech news</h1><p>Finteck Gate: Riham Ali</p><p>Cairo — the company issued a detailed statement on Sunday describing the incident, its causes, and the remediation steps now under way across the network.</p></body></html>`;
assert.strictEqual(await fetchAuthor('https://outlet.example/f'), 'Riham Ali', 'byline behind a huge nav still extracted');
assert.ok(lastAiText.includes('Riham Ali'), 'the byline is INSIDE the text window the model reads');
assert.ok(!lastAiText.includes('قسم الأخبار رقم 0'), 'nav chrome before the headline is skipped');

// 7. The AI cap is a PER-RUN budget: exhausting it must not poison the next
//    sweep in the same warm process (the bug that made a second "Backfill
//    authors" click return identical results with zero AI reads).
process.env.AUTHOR_AI_MAX = '1';
resetAuthorAiBudget();
anthropicCalls = 0;
anthropicReturn = '{"author": "Riham Ali"}';
pageHtml = '<html><body><h1>Fintech news</h1><p>Finteck Gate: Riham Ali</p><p>Cairo — the company issued a detailed statement on Sunday describing the incident, its causes, and the remediation steps now under way across the network.</p></body></html>';
assert.strictEqual(await fetchAuthor('https://outlet.example/g1'), 'Riham Ali', 'first AI call within budget');
assert.strictEqual(await fetchAuthor('https://outlet.example/g2'), null, 'budget exhausted → no AI read');
assert.strictEqual(anthropicCalls, 1, 'cap enforced within a run');
resetAuthorAiBudget();   // what each new sweep/run now does
assert.strictEqual(await fetchAuthor('https://outlet.example/g3'), 'Riham Ali', 'reset restores the budget for the next run');
assert.strictEqual(anthropicCalls, 2, 'AI reads again after reset');
delete process.env.AUTHOR_AI_MAX;
resetAuthorAiBudget();

// ── retry: a soft 403 on the first hit is recovered with a same-origin referer ──
articleAttempts = 0; statuses = [403, 200]; anthropicCalls = 0;
pageHtml = '<html><head><meta name="author" content="Sara Adel"></head><body><h1>x</h1></body></html>';
assert.strictEqual(await fetchAuthor('https://retry.example/a'), 'Sara Adel', 'a first-hit 403 is retried and recovers the byline');
assert.strictEqual(articleAttempts, 2, 'exactly one retry after the 403');
assert.strictEqual(anthropicCalls, 0, 'meta byline on retry → no AI call');

// ── persistent block → null after the single retry (no infinite loop) ──
articleAttempts = 0; statuses = [403, 403];
assert.strictEqual(await fetchAuthor('https://blocked.example/a'), null, 'persistent 403 → null');
assert.strictEqual(articleAttempts, 2, 'retried once, then gave up');
statuses = null;

console.log('AI-AUTHOR OK — meta hit skips AI; plain-text byline → 1 AI call; no byline → null; AUTHOR_AI=0 disables; junk name rejected; 403 retried once (recovers soft-blocks, gives up on hard blocks)');
