// Email + Report: action sections are Vodafone-only; competitors are market intel.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RADAR_TOKEN = 'tok';

const now = new Date().toISOString();
const H = {
  vodNeg: 'Vodafone Cash outage angers users',
  vodPos: 'Vodafone wins network award',
  orgPos: 'Orange Money and MEICO sign MoU for InsurTech',
  orgNeg: 'Orange billing glitch frustrates subscribers',
  weNeu: 'WE announces routine maintenance window',
};
const items = [
  { id: 1, brand: 'Vodafone', headline: H.vodNeg, summary: 's', sentiment: 'negative', importance: 5, category: 'vodafone_cash', published_at: now, seen_at: now },
  { id: 2, brand: 'Vodafone', headline: H.vodPos, summary: 's', sentiment: 'positive', importance: 3, category: 'brand', published_at: now, seen_at: now },
  { id: 3, brand: 'Orange', headline: H.orgPos, summary: 's', sentiment: 'positive', importance: 4, category: 'corporate', published_at: now, seen_at: now },
  { id: 4, brand: 'Orange', headline: H.orgNeg, summary: 's', sentiment: 'negative', importance: 5, category: 'billing', published_at: now, seen_at: now },
  { id: 5, brand: 'WE', headline: H.weNeu, summary: 's', sentiment: 'neutral', importance: 2, category: 'network', published_at: now, seen_at: now },
];

// ---- Email (renderBulletin is pure over items) ----
const { renderBulletin } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');
const html = renderBulletin({ items, broken: [], scanned: 5, greetingName: 'Team' });

// Locate section boundaries by their labels, then check which headlines fall in each.
const idxRisk = html.indexOf('Needs a response');
const idxWins = html.indexOf('Wins to amplify');
const idxMkt  = html.indexOf('Market &amp; noted');
assert.ok(idxRisk >= 0 && idxWins >= 0 && idxMkt >= 0, 'all three email sections present, named like the board lanes');
// section order in source is negative, positive, neutral.
// The needs-a-response REGION starts at the top of the body, not at the lane
// heading: the highest-Impact story in that lane is lifted out as the "Read
// this first" hero and printed ABOVE the heading, which then reads "N more,
// after the one above". Slicing from idxRisk would put the hero outside its own
// lane and this test would pass only for stories that were not promoted.
assert.ok(html.indexOf('Read this first') >= 0 && html.indexOf('Read this first') < idxRisk,
  'the hero sits above the lane headings');
assert.ok(html.slice(0, idxRisk).includes(H.vodNeg),
  'the hero is the highest-Impact needs-a-response story');
const sliceRisk = html.slice(0, idxWins);
const sliceWins = html.slice(idxWins, idxMkt);
const sliceMkt  = html.slice(idxMkt);
assert.ok(sliceRisk.includes(H.vodNeg), 'Vodafone negative is under Needs a response');
assert.ok(!sliceRisk.includes(H.orgNeg), 'Orange negative is NOT under Needs a response');
assert.ok(sliceWins.includes(H.vodPos), 'Vodafone positive is under Wins to amplify');
assert.ok(!sliceWins.includes(H.orgPos), 'Orange positive is NOT under Wins to amplify');
assert.ok(sliceMkt.includes(H.orgNeg) && sliceMkt.includes(H.orgPos), 'competitor items live in the market section');
// Pills read the same on every brand — the tone for the brand the story is
// ABOUT, plainly named. Competitor cards are NOT relabelled; what keeps a
// rival's win out of our wins column is the lane, asserted above.
assert.ok(sliceMkt.includes('>Negative<') && sliceMkt.includes('>Positive<'), 'competitor cards carry plain sentiment pills');
for (const gone of ['Competitor win', 'Competitor setback', 'Competitor note']) {
  assert.ok(!html.includes(gone), `retired competitor pill wording must not reappear: ${gone}`);
}
assert.ok(sliceRisk.includes('>Negative<'), 'Vodafone card keeps the plain Negative pill');
assert.ok(sliceWins.includes('>Positive<'), 'Vodafone card keeps the plain Positive pill');
console.log('EMAIL OK — Needs a response & Wins to amplify are Vodafone-only (board lane names); competitors → Market & noted');

// ---- Report (buildReport hits the DB via fetch; mock it) ----
globalThis.fetch = async (url) => {
  const u = String(url);
  const rows = u.includes('/pr_instances') ? [] : items;
  return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
};
const { buildReport, renderReport } = await import(new URL('..', import.meta.url).pathname + '/lib/report.js');
const data = await buildReport({ days: 7 });
assert.ok(data.topNeg.length && data.topNeg.every((i) => i.brand === 'Vodafone'), 'report topNeg is Vodafone-only');
assert.ok(data.wins.length && data.wins.every((i) => i.brand === 'Vodafone'), 'report wins is Vodafone-only');
assert.ok(data.topNeg.some((i) => i.headline === H.vodNeg) && !data.topNeg.some((i) => i.headline === H.orgNeg), 'Vodafone neg in, Orange neg out');
assert.ok(data.wins.some((i) => i.headline === H.vodPos) && !data.wins.some((i) => i.headline === H.orgPos), 'Vodafone win in, Orange positive out');
// factual analytics still count the whole market
assert.ok(data.totals.positives >= 2, 'sentiment totals still count all brands (factual)');

const rhtml = renderReport(data, { period: 'week' });
assert.ok(rhtml.includes('Wins to amplify') && rhtml.includes(H.vodPos), 'report renders Vodafone win under Wins to amplify');
assert.ok(!rhtml.includes(H.orgPos), 'Orange positive not rendered as a win');
assert.ok(!rhtml.includes('Wins (positive)') && rhtml.includes('Positive'), 'KPI relabelled Positive (factual), not "Wins (positive)"');
console.log('REPORT OK — Wins to amplify & Top negatives are Vodafone-only; KPI is factual; analytics unchanged');

console.log('ALL EMAIL+REPORT LANE TESTS PASSED');
