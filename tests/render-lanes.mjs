// Verify "Wins to amplify" is Vodafone-only; competitor positives → "Market & noted".
// Also pins the sentiment convention: every card shows the tone for the brand it
// is ABOUT (never inverted for Vodafone), labelled plainly Negative/Neutral/Positive.
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
  try { const b = readFileSync(DIR + f);
    // /assets/session.js is a real script now — serve it as one. A page whose
    // shared session module arrives as text/html has no afetch at all.
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
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

// Sentiment is the brand's OWN tone — the identical scale on every card, with
// no per-brand relabelling. A rival's win is Positive (positive for them); a
// rival's stumble is Negative. Lanes stay Vodafone-only (asserted above), which
// is what keeps a rival's good news out of "Wins to amplify".
await page.click('#sentRow .chip[data-v="all"]'); await page.waitForTimeout(150);
const badges = {};
for (const id of [1, 2, 3, 4, 5]) badges[id] = await page.$eval(`#item-${id} .sent`, e => e.textContent.trim());
assert.deepStrictEqual(badges, {
  1: 'Positive',   // Vodafone award
  2: 'Positive',   // Orange MoU — positive FOR ORANGE, not relabelled
  3: 'Negative',   // Vodafone Cash outage
  4: 'Neutral',    // WE corporate note
  5: 'Negative',   // Orange billing glitch — negative FOR ORANGE
}, `every card shows the plain sentiment of the brand it is about (got ${JSON.stringify(badges)})`);
assert.ok(await page.$eval('#item-2 .sent', e => e.classList.contains('positive')), 'colour matches the label');
assert.ok(await page.$eval('#item-5 .sent', e => e.classList.contains('negative')), 'colour matches the label');
// No surface may reintroduce the old inverted vocabulary.
const bodyTxt = await page.$eval('body', e => e.innerText);
for (const gone of ['Competitor win', 'Competitor setback', 'Competitor note', 'unfavourable', 'Unfavourable']) {
  assert.ok(!bodyTxt.includes(gone), `retired wording must not reappear: ${gone}`);
}

// A rival's tile counts THEIR wins — their positive coverage, the thing that
// invites a comparative response. Same number as before the convention flipped,
// read off the other end of the scale.
const orangeTile = await page.$eval('.tile[data-b="Orange"] .tc-cnt', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.strictEqual(orangeTile, '1 win · 2', `Orange tile counts their positive stories (got ${orangeTile})`);
const weTile = await page.$eval('.tile[data-b="WE"] .tc-cnt', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.strictEqual(weTile, '0 wins · 1', `WE tile pluralises correctly (got ${weTile})`);
// Status counts negatives across every brand — now literally true, so it says so.
const statusTxt = await page.$eval('#status', e => e.textContent.replace(/\s+/g, ' ').trim());
assert.ok(/2 negative/.test(statusTxt), `status counts negative stories plainly (got ${statusTxt})`);
// the Vodafone hero is Vodafone-only and unchanged
assert.ok(/negative/.test(await page.$eval('.hero', e => e.textContent)), 'Vodafone hero still reads "negative"');

// The severity dots are labelled Impact, not Reach. "Reach" read as audience
// size, but the field weighs how directly a story hits Vodafone as well as how
// far it travelled — a small outlet landing squarely on us outranks a big one
// that barely mentions us. The board is where this vocabulary originates and
// lib/email.js mirrors it, so a rename that survives on only one surface breaks
// the one-design-system rule (render-email-design pins the email half).
const dlab = await page.$eval('.dots .dlab', e => e.textContent.trim());
assert.strictEqual(dlab, 'Impact', `the card's severity dots are labelled Impact (got "${dlab}")`);
const dtip = await page.$eval('.dots', e => e.getAttribute('title'));
assert.ok(/matters to us/.test(dtip), `the tooltip says what the score measures (got "${dtip}")`);

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Impact is five fat DASHES, the same mark the emails use — five 9px dots two
// shades apart are one smudge at arm's length, and the board is where a reader
// spends longer. The count is what carries the level; the colour is redundant,
// which is why five marks always render and n of them are filled.
{
  const imp = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.card')) {
      const marks = [...card.querySelectorAll('.dots .idash')];
      const box = marks[0] && marks[0].getBoundingClientRect();
      out.push({
        id: card.id,
        marks: marks.length,
        filled: marks.filter((m) => getComputedStyle(m).backgroundColor !== getComputedStyle(document.body).getPropertyValue('--dot-empty')).length,
        w: box ? Math.round(box.width) : 0,
        h: box ? Math.round(box.height) : 0,
        glyphs: /[●○]/.test(card.querySelector('.dots').textContent || ''),
      });
    }
    return out;
  });
  assert.ok(imp.length, 'cards rendered');
  for (const c of imp) {
    assert.strictEqual(c.marks, 5, `${c.id}: always five Impact marks, filled and empty`);
    assert.ok(c.w >= 9 && c.h >= 5, `${c.id}: the mark is a dash, not a dot (got ${c.w}x${c.h})`);
    assert.ok(c.w > c.h, `${c.id}: wider than tall — that is what makes it legible at arm's length`);
    assert.ok(!c.glyphs, `${c.id}: no ● / ○ glyphs left over from the dot version`);
  }
}

await browser.close(); server.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
if (overflow > 1) { console.error('overflow', overflow); process.exit(1); }
console.log('LANE TEST PASSED — Wins=Vodafone-only; competitor positive is Market & noted; every pill reads the brand\'s own plain sentiment, no inversion left anywhere');
