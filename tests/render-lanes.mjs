// Verify "Wins to amplify" is Vodafone-only; competitor positives → "Market & noted".
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import assert from 'node:assert';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const now = new Date().toISOString();
const items = [
  { id: 1, brand: 'Vodafone', headline: 'Vodafone wins network award', summary: 's', sentiment: 'positive', importance: 3, category: 'brand', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
  { id: 2, brand: 'Orange', headline: 'Orange Money & MEICO sign MoU for InsurTech', summary: 's', sentiment: 'positive', importance: 3, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [{ outlet: 'A', url: 'u' }, { outlet: 'B', url: 'u2' }] },
  { id: 3, brand: 'Vodafone', headline: 'Vodafone Cash outage angers users', summary: 's', sentiment: 'negative', importance: 5, category: 'vodafone_cash', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
  { id: 4, brand: 'WE', headline: 'WE neutral corporate note', summary: 's', sentiment: 'neutral', importance: 2, category: 'corporate', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
  { id: 5, brand: 'Orange', headline: 'Orange billing glitch frustrates subscribers', summary: 's', sentiment: 'negative', importance: 5, category: 'billing', url: 'u', resolved_url: 'u', published_at: now, instances: [] },
];

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(items)); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8902, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8902/?t=tok&win=30', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card', { timeout: 4000 });

// helper: which section header precedes a given card id
const sectionOf = (id) => page.evaluate((id) => {
  let el = document.getElementById('item-' + id); if (!el) return null;
  for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList.contains('sechead')) return n.querySelector('.lab').textContent.trim();
  }
  return null;
}, id);

// widen to Month so nothing is filtered by time
await page.click('#winRow .chip[data-v="30"]'); await page.waitForTimeout(150);
await page.waitForSelector('.card');

assert.strictEqual(await sectionOf(1), 'Wins to amplify', 'Vodafone positive → Wins to amplify');
assert.strictEqual(await sectionOf(2), 'Market & noted', 'Orange (competitor) positive → Market & noted, NOT a win');
assert.strictEqual(await sectionOf(3), 'Needs a response', 'Vodafone negative → Needs a response');
assert.strictEqual(await sectionOf(4), 'Market & noted', 'neutral → Market & noted');
assert.strictEqual(await sectionOf(5), 'Market & noted', 'Orange (competitor) NEGATIVE → Market & noted, NOT Needs a response');
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'board-lanes.png', fullPage: true });

// spotlight "Needs eyes now" fires only for Vodafone — never a competitor
const spotOn = await page.$eval('#spotlight', el => el.classList.contains('on'));
const spotText = await page.$eval('#spotlightText', el => el.textContent);
assert.ok(spotOn, 'spotlight is shown (a Vodafone negative exists)');
assert.ok(/Vodafone/.test(spotText) && !/Orange/.test(spotText), 'spotlight highlights the Vodafone negative, not the competitor');
// competitor negative card does NOT get the critical red-ring
const orgCrit = await page.$eval('#item-5', el => el.classList.contains('crit'));
const vodCrit = await page.$eval('#item-3', el => el.classList.contains('crit'));
assert.ok(!orgCrit, 'competitor negative is not marked critical');
assert.ok(vodCrit, 'Vodafone negative (imp 5) is still critical');

// the "Wins" filter shows only Vodafone wins (competitor positive excluded)
await page.click('#sentRow .chip[data-v="positive"]'); await page.waitForTimeout(150);
const winCards = await page.$$eval('.card', els => els.map(e => e.id));
assert.deepStrictEqual(winCards, ['item-1'], 'Wins filter shows only the Vodafone win');
// the "Market" filter includes the competitor positive
await page.click('#sentRow .chip[data-v="neutral"]'); await page.waitForTimeout(150);
const mktCards = await page.$$eval('.card', els => els.map(e => e.id).sort());
assert.deepStrictEqual(mktCards, ['item-2', 'item-4', 'item-5'], 'Market filter = all competitor items + neutral');

// Competitor cards relabel the pill so the Vodafone-standpoint convention is
// self-explanatory: stored "positive" = the rival stumbled (good for us),
// stored "negative" = the rival won (counts against us). Colour/lane unchanged.
await page.click('#sentRow .chip[data-v="all"]'); await page.waitForTimeout(150);
const badge2 = await page.$eval('#item-2 .sent', e => e.textContent.trim());
assert.strictEqual(badge2, 'Competitor setback', 'competitor positive reads as a rival stumble');
assert.ok(await page.$eval('#item-2 .sent', e => e.classList.contains('positive')), 'colour still encodes Vodafone impact');
const badge5 = await page.$eval('#item-5 .sent', e => e.textContent.trim());
assert.strictEqual(badge5, 'Competitor win', 'competitor negative reads as a rival win');
const badge4 = await page.$eval('#item-4 .sent', e => e.textContent.trim());
assert.strictEqual(badge4, 'Competitor note', 'competitor neutral reads as market colour');
// Vodafone cards keep the plain sentiment wording
const badge1 = await page.$eval('#item-1 .sent', e => e.textContent.trim());
assert.strictEqual(badge1, 'Positive', 'Vodafone card keeps the plain Positive pill');
const badge3 = await page.$eval('#item-3 .sent', e => e.textContent.trim());
assert.strictEqual(badge3, 'Negative', 'Vodafone card keeps the plain Negative pill');

// Pulse tiles + status counter must not read backwards on competitors: a rival
// story scored "negative" is a WIN for them, so "N neg" on their tile would say
// the opposite of the truth.
const orangeTile = await page.$eval('.tile[data-b="Orange"] .tc-cnt', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.strictEqual(orangeTile, '1 win · 2', `Orange tile counts wins, not "neg" (got ${orangeTile})`);
const weTile = await page.$eval('.tile[data-b="WE"] .tc-cnt', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.strictEqual(weTile, '0 wins · 1', `WE tile pluralises correctly (got ${weTile})`);
const statusTxt = await page.$eval('#status', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.ok(/2 against us/.test(statusTxt), `status counts what moved against Vodafone (got ${statusTxt})`);
assert.ok(!/negative/.test(statusTxt), 'status no longer says "negative" (it mixes our bad news with rivals\' wins)');
// the Vodafone hero keeps the plain wording — it is Vodafone-only
assert.ok(/negative/.test(await page.$eval('.hero', e => e.textContent)), 'Vodafone hero still reads "negative"');

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('LANE TEST PASSED — Wins=Vodafone-only; competitor positive is Market & noted; competitor pills relabelled (win/setback/note), Vodafone pills plain');
