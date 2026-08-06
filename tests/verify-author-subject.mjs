// The SUBJECT of a story is never its author.
//
// Live, 6 Aug: an Ahram Online interview — "INTERVIEW| Egypt mobile wallet market
// triples since COVID, Axis Pay targets 3 mln users: Axis CEO" (pr_items #1960)
// — was filed with the byline "Jacques Marco", who is the Axis Pay CEO being
// interviewed. The board credited the person the story is ABOUT as the
// journalist who wrote it, which is worse than an honest "—": it attributes
// words to a named person on a screen the PR team reads as fact.
//
// The AI prompt ALREADY said "never a person merely mentioned or quoted in the
// story (an official, a CEO)". So this test does not pin a prompt; it pins the
// deterministic guards that now sit on BOTH extraction paths, because a
// judgement the model gets wrong needs a check beside the instruction.
//
// It must also NOT overreach: a real byline that happens to sit near a quote,
// or a story about an executive written by someone else, must still resolve.
import assert from 'node:assert';

process.env.AUTHOR_AI = '0';                   // deterministic paths first
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

const ROOT = new URL('..', import.meta.url).pathname;
const { extractAuthorFromHtml, isStorySubject, isNamedInHeadline, fetchAuthor, resetAuthorAiBudget } =
  await import(ROOT + 'lib/author.js');

/* ── 1. the live failure, reproduced ──────────────────────────────────────── */
// Shaped like the real page: an interview whose opening names the interviewee
// and their title, with the site declaring that name in its metadata too (an
// interviewee reaches JSON-LD and metas, which is why the guard cannot live
// only on the AI path).
const HEADLINE = 'INTERVIEW| Egypt mobile wallet market triples since COVID, Axis Pay targets 3 mln users: Axis CEO - Tech - Business';
const interview = `<html><head>
  <meta name="author" content="Jacques Marco">
  <script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Jacques Marco"}}</script>
  </head><body><article>
  <h1>${HEADLINE}</h1>
  <p>Egypt's mobile wallet market has tripled since the COVID-19 pandemic, Jacques Marco, CEO of Axis Pay, said in an interview with Ahram Online.</p>
  <p>"We are targeting 3 million users," Marco added.</p>
  </article></body></html>`;

assert.strictEqual(extractAuthorFromHtml(interview, 'Ahram Online', { headline: HEADLINE }), null,
  'the interviewee is NOT stored as the author, even though the page declares him in JSON-LD and the author meta');
// The two signals, checked directly so a future change can see which one fired.
assert.ok(isStorySubject('Jacques Marco', 'Jacques Marco, CEO of Axis Pay, said in an interview'),
  'a name beside a job title reads as the subject');
assert.ok(isStorySubject('Jacques Marco', 'the market has tripled, said Jacques Marco'),
  'and so does one introduced by a quote verb');

/* ── 2. …and the same page WITH a real byline still yields it ─────────────── */
// The guard must not turn every interview into a bylineless card: Ahram prints
// the journalist under the headline, and that name wins.
const withByline = interview.replace('<h1>', '<span class="byline">By Ahmed Abdel-Hafez</span><h1>');
assert.strictEqual(extractAuthorFromHtml(withByline, 'Ahram Online', { headline: HEADLINE }), 'Ahmed Abdel-Hafez',
  'the journalist credited on the page is still extracted');

/* ── 3. no overreach: a byline sitting near a quote survives ──────────────── */
// "By X" followed immediately by a quoted official is the ordinary shape of a
// news story. Rejecting that would cost real bylines on most political copy.
const ordinary = `<html><head><meta name="author" content="Mona Said"></head><body><article>
  <h1>Minister opens new data centre</h1>
  <p>By Mona Said</p>
  <p>The minister said the project would create jobs, and the CEO of the operator added that coverage would follow.</p>
  </article></body></html>`;
assert.strictEqual(extractAuthorFromHtml(ordinary, 'Daily News Egypt', { headline: 'Minister opens new data centre' }), 'Mona Said',
  'a normal byline beside quoted officials is untouched');

// Even when the journalist's own name appears again next to a quote verb, an
// explicit credit anywhere on the page wins.
assert.strictEqual(
  isStorySubject('Mona Said', 'By Mona Said. The minister spoke to Mona Said, who said the plan was clear.'),
  false,
  'an explicitly credited name is never treated as the subject');

/* ── 4. a name in the HEADLINE is not the byline ──────────────────────────── */
assert.ok(isNamedInHeadline('Jacques Marco', 'Axis CEO Jacques Marco on the wallet boom'), 'named in the headline');
assert.ok(!isNamedInHeadline('Ahmed Abdel-Hafez', HEADLINE), 'a journalist is not in the headline');
const namedInHead = `<html><head><meta name="author" content="Hassan Allam"></head><body><article>
  <h1>Hassan Allam wins the metro contract</h1><p>The company confirmed the award on Tuesday.</p>
  </article></body></html>`;
assert.strictEqual(extractAuthorFromHtml(namedInHead, 'Al Mal', { headline: 'Hassan Allam wins the metro contract' }), null,
  'a name lifted from the headline is refused as a byline');

/* ── 5. Arabic: the same trap, the same guard ─────────────────────────────── */
const arabicHead = 'الرئيس التنفيذي لفودافون مصر: الاستثمار في الشبكة مستمر';
const arabic = `<html><head>
  <script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"محمد سعيد"}}</script>
  </head><body><article><h1>${arabicHead}</h1>
  <p>قال محمد سعيد الرئيس التنفيذي لشركة فودافون مصر إن الاستثمارات مستمرة.</p>
  </article></body></html>`;
assert.strictEqual(extractAuthorFromHtml(arabic, 'اليوم السابع', { headline: arabicHead }), null,
  'an Arabic executive quoted in the story is not its author');
const arabicByline = arabic.replace('<p>قال', '<p>كتب: أحمد عبد السلام</p><p>قال');
assert.strictEqual(extractAuthorFromHtml(arabicByline, 'اليوم السابع', { headline: arabicHead }), 'أحمد عبد السلام',
  'while a real Arabic byline on the same page is kept');

/* ── 6. the AI fallback answer goes through the SAME guard ────────────────── */
// This is the path most likely to have produced the live failure: the cascade
// finds nothing, the model reads an opening dominated by the interviewee, and
// returns them despite being told not to. The instruction is not the guard.
process.env.AUTHOR_AI = '1';
process.env.ANTHROPIC_API_KEY = 'sk-test';
let prompts = [];
const page = `<html><body><article><h1>${HEADLINE}</h1>
  <p>Egypt's mobile wallet market has tripled since COVID-19, Jacques Marco, CEO of Axis Pay, told Ahram Online in an interview at the company's Cairo office. He said the firm is targeting 3 million users by the end of next year, up from about one million today, and that the digital payments segment is expanding faster than any other part of the market.</p>
  </article></body></html>`;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    prompts.push(JSON.parse(opts.body));
    // The model does exactly what it did in production.
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"author":"Jacques Marco"}' }] }) };
  }
  if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  return { ok: true, status: 200, text: async () => page };
};
resetAuthorAiBudget();
assert.strictEqual(await fetchAuthor('https://english.ahram.org.eg/News/574148.aspx', 'Ahram Online', { headline: HEADLINE }), null,
  'a model that returns the interviewee anyway is overruled');
assert.strictEqual(prompts.length, 1, 'the model was actually consulted (the guard is not just short-circuiting the call)');
// It is also given the headline now — it was reading the body blind, which is
// why "INTERVIEW ... : Axis CEO" could not inform its answer.
assert.ok(/HEADLINE: INTERVIEW\|/.test(prompts[0].messages[0].content), 'the headline is passed as context');
assert.ok(/INTERVIEWS are the trap/i.test(prompts[0].system), 'and the prompt names the interview case explicitly');

/* ── 7. the AI path still returns a REAL byline ───────────────────────────── */
prompts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    prompts.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"author":"Riham Ali"}' }] }) };
  }
  if (u.includes('/rest/v1/')) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  return { ok: true, status: 200, text: async () => `<html><body><article><h1>Vodafone Egypt expands its network</h1>
    <p>Fintech Gate: Riham Ali</p><p>Vodafone Egypt said it would expand coverage in Upper Egypt this year, adding sites across three governorates.</p>
    </article></body></html>` };
};
resetAuthorAiBudget();
assert.strictEqual(await fetchAuthor('https://outlet.example/a', 'Fintech Gate', { headline: 'Vodafone Egypt expands its network' }), 'Riham Ali',
  'an unlabelled real byline is still recovered by the AI fallback');

console.log('AUTHOR-SUBJECT OK — an interviewee/executive is refused as the byline on BOTH paths (JSON-LD, author meta AND the AI answer), in English and Arabic, whether the giveaway is a job title, a quote verb or the headline itself; a real byline on the same page still wins, an explicitly credited name is never treated as a subject, and ordinary copy quoting officials is untouched');
