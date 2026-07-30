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
const idxRisk = html.indexOf('reputational risk');
const idxWins = html.indexOf('brand wins');
const idxMkt  = html.indexOf('market &');
assert.ok(idxRisk >= 0 && idxWins >= 0 && idxMkt >= 0, 'all three email sections present');
// section order in source is negative, positive, neutral
const sliceRisk = html.slice(idxRisk, idxWins);
const sliceWins = html.slice(idxWins, idxMkt);
const sliceMkt  = html.slice(idxMkt);
assert.ok(sliceRisk.includes(H.vodNeg), 'Vodafone negative is under reputational risk');
assert.ok(!sliceRisk.includes(H.orgNeg), 'Orange negative is NOT under reputational risk');
assert.ok(sliceWins.includes(H.vodPos), 'Vodafone positive is under brand wins');
assert.ok(!sliceWins.includes(H.orgPos), 'Orange positive is NOT under brand wins');
assert.ok(sliceMkt.includes(H.orgNeg) && sliceMkt.includes(H.orgPos), 'competitor items live in the market section');
// Competitor pills are relabelled so the Vodafone-standpoint convention reads
// correctly in the inbox: stored negative = the rival won (counts against us),
// stored positive = the rival stumbled. Vodafone cards keep the plain wording.
assert.ok(sliceMkt.includes('Competitor win') && sliceMkt.includes('Competitor setback'), 'competitor pills are relabelled in the market section');
assert.ok(!sliceMkt.includes('>Negative<') && !sliceMkt.includes('>Positive<'), 'no bare sentiment pill on a competitor card');
assert.ok(sliceRisk.includes('>Negative<'), 'Vodafone card keeps the plain Negative pill');
assert.ok(sliceWins.includes('>Positive<'), 'Vodafone card keeps the plain Positive pill');
console.log('EMAIL OK — reputational risk & brand wins are Vodafone-only; competitors → market');

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
