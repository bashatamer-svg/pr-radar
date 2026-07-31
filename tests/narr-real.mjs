// Narrative clustering regression over REAL production items (narr-fixture):
// every false merge observed in production must stay dead, every genuine
// narrative must stay grouped. Runs the actual stats handler.
import assert from 'node:assert';
import { ITEMS } from './narr-fixture.mjs';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
  if (u.includes('/rest/v1/pr_items')) {
    const offset = Number((u.match(/offset=(\d+)/) || [])[1] || 0);
    return ok(offset === 0 ? ITEMS : []);
  }
  return ok([]);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/stats.js');
let body;
const res = { status: () => res, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
await handler({ query: { days: '30' }, headers: { authorization: 'Bearer tok' } }, res);
const narrs = body.narratives;
const clusterOf = (id) => narrs.find((n) => (n.ids || []).includes(id));
const together = (a, b) => { const c = clusterOf(a); return !!c && c.ids.includes(b); };

// ── false merges that must STAY dead ──
assert.ok(!together(2, 97), 'AEON crypto and GEM tickets are not one narrative');
assert.ok(!together(3, 22), 'e& stake sale and Helios data-center cancel are not one narrative');
assert.ok(!together(296, 353), 'e& She Blooms and WE She Leads are not one narrative');
assert.ok(!together(207, 710) && !together(207, 711), 'TE and Orange supply-ministry stories are separate narratives');
assert.ok(!together(709, 277) && !together(709, 342), 'the ATM complaint is not buried in a cash-mentions cluster');
// 719 stood alone when this fixture was first captured; the 2026-07-31 recapture
// added its two follow-ups, so it is now a genuine three-story thread. What must
// NOT join it is 971 — a VODAFONE real-estate partnership that shares only the
// vocabulary of every property press release ("smart digital infrastructure",
// "strategic partnership", "project").
const saada = clusterOf(719);
assert.ok(saada && saada.ids.includes(839) && saada.ids.includes(843), 'the three e& / Horizon Saada stories are one narrative');
assert.ok(!saada.ids.includes(971), 'Vodafone\'s La Courbe deal is NOT part of the e& Saada narrative');
assert.ok(!clusterOf(206), 'university scholarships joins nothing');
assert.ok(!together(624, 207) && !together(624, 353), 'search-ranking stories not chained into supply/She-Leads');

// ── genuine narratives that must STAY grouped ──
const ahly = clusterOf(432);
assert.ok(ahly && [501, 722, 723, 744, 746, 747].every((id) => ahly.ids.includes(id)), 'all 7 Al-Ahly stories are ONE narrative (split healed)');
const pricing = clusterOf(63);
assert.ok(pricing && [122, 606, 618, 630, 717].every((id) => pricing.ids.includes(id)), 'the 6 sector price stories are one narrative');
assert.ok(together(275, 276), 'umlaut EN + AR recaps are one narrative');
assert.ok(together(207, 208), 'TE supply-ministry pair intact');
const orangeSupply = clusterOf(710);
assert.ok(orangeSupply && orangeSupply.ids.includes(711) && orangeSupply.brand === 'Orange', 'Orange supply pair intact and branded Orange (not WE)');
assert.ok(together(353, 362), 'WE She Leads pair intact');
assert.ok(together(296, 361) && together(296, 430), 'e& She Blooms trio intact');
assert.ok(together(28, 205), 'TE data-center strategy pair intact');
assert.ok(together(559, 622) && together(559, 721), 'WE search-interest trio intact');

// ── false merges found in the 2026-07-31 review ──
// A plagiarism row about the music in a Vodafone AD is not the sponsorship
// story. Both are brand Vodafone, category campaign, and both say "إعلان
// فودافون" — token overlap alone cannot tell them apart, so the generic
// announcement vocabulary had to stop counting as theme.
assert.ok(!together(432, 1162) && !together(432, 1164), 'the ad-melody plagiarism row is not part of the Al-Ahly narrative');
assert.ok(together(1162, 1164), 'the two plagiarism stories are their own narrative');
// "تطلق" (launches) is what a press release DOES, not which story it is.
assert.ok(!together(432, 899), 'stadium naming and the prosecution-services rollout are separate');
const pros = clusterOf(867);
assert.ok(pros && [899, 1053, 1078].every((id) => pros.ids.includes(id)), 'the Public-Prosecution-on-Vodafone stories are one narrative, across categories');
// Two companies reporting revenue in billions of EGP is not one story.
assert.ok(!together(853, 1069), 'Vodafone Q2 revenue and e& H1 revenue are separate narratives');
assert.ok(together(853, 856) && together(853, 962), 'the Vodafone revenue stories are one narrative');
// The Al-Ahly thread survives the classifier filing it under two categories.
assert.ok(together(432, 760) && together(432, 900), 'Al-Ahly stories filed as corporate still join the campaign thread');

// ── names must read as titles, not keyword bags ──
for (const n of narrs) {
  const bare = n.name.replace(/^[^·]+·\s*/, '');
  assert.ok(bare.length >= 4, `narrative name is not a stub: "${n.name}"`);
  assert.ok(!/^(تطلق|تعلن|launches|announces)$/i.test(bare), `narrative name is not a bare verb: "${n.name}"`);
}

// ── structural sanity ──
const seen = new Set();
for (const n of narrs) {
  assert.ok(n.total >= 2, `narrative "${n.name}" has >=2 stories`);
  for (const id of n.ids) { assert.ok(!seen.has(id), `item ${id} appears in only one narrative`); seen.add(id); }
}
console.log(`NARR-REAL OK — ${narrs.length} narratives over real production items: all false merges dead, all genuine groups intact, no overlaps`);
