// VERIFY step 4 — board bidi. Serve public/ + a stubbed /api/items with a mixed
// Arabic/English headline, load the board, and check the headline computes RTL
// with text-align matching, while "5G"/"Vodafone Cash" stay intact (LTR runs),
// and the spotlight keeps the headline isolated after the Latin prefix.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + '/public';
const HEADLINE = 'انقطاع خدمة فودافون كاش Vodafone Cash يثير غضب المستخدمين بعد تحديث 5G الجديد!';
const ITEM = {
  id: 1, brand: 'Vodafone', headline: HEADLINE, summary: 'تفاصيل Vodafone Cash و 5G هنا.',
  sentiment: 'negative', importance: 5, category: 'vodafone_cash', country: 'Egypt',
  author: 'محمد علي', url: 'https://x/a', resolved_url: 'https://x/a',
  published_at: new Date().toISOString(),
  instances: [{ outlet: 'Youm7', author: 'محمد علي', url: 'https://x/a' }, { outlet: 'المصري اليوم', author: null, url: 'https://x/b' }],
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/items') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([ITEM])); }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { const b = readFileSync(DIR + f); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(8891, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'x', refresh_token: 'r' })));
await page.goto('http://localhost:8891/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const info = await page.evaluate(() => {
  const a = document.querySelector('.headline a') || document.querySelector('.headline');
  const cs = getComputedStyle(document.querySelector('.headline'));
  const box = a.getBoundingClientRect();
  const centerX = box.left + box.width / 2;
  // Geometric RTL proof: unicode-bidi:plaintext leaves computed `direction`
  // unchanged but resolves the paragraph base from the first strong char
  // (Arabic → RTL). Under RTL layout the LOGICAL-LAST char ("!") renders at the
  // visual LEFT and the logical-first Arabic char renders at the visual RIGHT.
  const txt = a.firstChild; // text node
  const rectOf = (start, len) => { const r = document.createRange(); r.setStart(txt, start); r.setEnd(txt, start + len); return r.getBoundingClientRect(); };
  const full = txt.textContent;
  const bangRect = rectOf(full.length - 1, 1);          // the "!"
  const firstRect = rectOf(0, 1);                        // first Arabic char
  const gIdx = full.indexOf('5G');
  const g0 = rectOf(gIdx, 1), g1 = rectOf(gIdx + 1, 1); // "5" then "G"
  const spot = document.querySelector('#spotlightText');
  const bdi = spot && spot.querySelector('bdi');
  return {
    unicodeBidi: cs.unicodeBidi,
    textAlign: cs.textAlign,
    centerX,
    bangLeft: bangRect.left,
    firstLeft: firstRect.left,
    // "5G" is an LTR run: "5" must sit to the LEFT of "G" (not reversed)
    fiveBeforeG: g0.left < g1.left,
    has5G: full.includes('5G'),
    hasVodafoneCash: full.includes('Vodafone Cash'),
    endsWithBang: full.trim().endsWith('!'),
    spotlightHasBdi: !!bdi,
    spotlightBdiText: bdi && bdi.textContent,
    spotlightPrefixLatin: !!(spot && /Vodafone/.test(spot.textContent)),
  };
});
await page.screenshot({ path: new URL('./out/', import.meta.url).pathname + 'bidi-board.png', fullPage: true });
console.log(JSON.stringify(info, null, 2));

const fail = [];
if (errors.length) fail.push('pageerrors: ' + errors.join(';'));
if (info.unicodeBidi !== 'plaintext') fail.push('unicode-bidi not plaintext: ' + info.unicodeBidi);
if (info.textAlign !== 'start') fail.push('text-align not start: ' + info.textAlign);
if (!(info.bangLeft < info.centerX)) fail.push(`trailing ! not on visual LEFT (bang ${info.bangLeft.toFixed(0)} vs center ${info.centerX.toFixed(0)}) — not RTL`);
if (!(info.firstLeft > info.centerX)) fail.push(`first Arabic char not on visual RIGHT (${info.firstLeft.toFixed(0)} vs center ${info.centerX.toFixed(0)}) — not RTL`);
if (!info.fiveBeforeG) fail.push('"5G" reversed — LTR run scrambled');
if (!info.has5G) fail.push('5G not intact');
if (!info.hasVodafoneCash) fail.push('Vodafone Cash not intact');
if (!info.endsWithBang) fail.push('trailing ! lost from logical string');
if (!info.spotlightHasBdi) fail.push('spotlight missing <bdi>');
if (!info.spotlightPrefixLatin) fail.push('spotlight Latin prefix missing');

await browser.close(); server.close();
if (fail.length) { console.error('BIDI FAIL:\n' + fail.join('\n')); process.exit(1); }
console.log('BIDI VERIFY PASSED — headline RTL, 5G + Vodafone Cash intact, spotlight bdi-isolated');
