// The inbox and the app must read as one product: lib/email.js renders with the
// BOARD's design tokens (public/index.html :root). This pins that alignment —
// and guards the quoting bug that silently killed styles when the system font
// stack was first introduced.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

process.env.BOARD_URL = 'https://pr-radar.example.com/';
const { renderBulletin, renderUrgent, renderWelcome, THEME } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');

// Pull the real values out of the board's :root so this can't rot silently.
const board = readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
const token = (name) => {
  const m = board.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`, 'i'));
  assert.ok(m, `board defines --${name}`);
  return m[1].toLowerCase();
};
const BOARD = { ink: token('ink'), ink2: token('ink-2'), muted: token('muted'), faint: token('faint'), bg: token('bg'), hair: token('hair'), red: token('red') };

// 1. The email's exported theme IS the board's palette.
assert.strictEqual(THEME.INK.toLowerCase(), BOARD.ink, 'email INK = board --ink');
assert.strictEqual(THEME.INK_SOFT.toLowerCase(), BOARD.ink2, 'email INK_SOFT = board --ink-2');
assert.strictEqual(THEME.MUTED.toLowerCase(), BOARD.muted, 'email MUTED = board --muted');
assert.strictEqual(THEME.FAINT.toLowerCase(), BOARD.faint, 'email FAINT = board --faint');
assert.strictEqual(THEME.CANVAS.toLowerCase(), BOARD.bg, 'email CANVAS = board --bg');
assert.strictEqual(THEME.HAIRLINE.toLowerCase(), BOARD.hair, 'email HAIRLINE = board --hair');
assert.strictEqual(THEME.RED.toLowerCase(), BOARD.red, 'email RED = board --red');

// 1b. So is the brand chip. This is the same object in the inbox and on the
// board, so its colour must not change under a reader who taps through.
// Two had silently drifted (market #6d605d vs #6c7480, WE #6a1b9a vs #7b1fa2)
// and survived for months because no email test rendered either brand — the
// market colour was even on the retired-palette blocklist below. Comparing the
// whole map, rather than the brands that happen to be in a fixture, is what
// makes that impossible rather than unlikely.
{
  const m = board.match(/const BRAND_COLOR\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'board defines BRAND_COLOR');
  const boardBrands = {};
  for (const b of m[1].matchAll(/'?([A-Za-z&]+)'?\s*:\s*'(#[0-9a-f]{3,8})'/gi)) boardBrands[b[1]] = b[2].toLowerCase();
  assert.ok(Object.keys(boardBrands).length >= 5, 'parsed the board brand map');
  for (const [brand, colour] of Object.entries(boardBrands)) {
    assert.strictEqual((THEME.BRAND_COLOR[brand] || '').toLowerCase(), colour,
      `email BRAND_COLOR.${brand} = board BRAND_COLOR.${brand}`);
  }
}

const now = new Date().toISOString();
const item = {
  id: 1, brand: 'Vodafone', headline: 'Cash outage', summary: 's', sentiment: 'negative',
  importance: 5, category: 'vodafone_cash', source: 'Youm7', author: 'محمد علي', country: 'Egypt',
  published_at: now, seen_at: now,
  pr_angle: 'Read · x\nAudience · y\nAction · z',
  _instances: [{ outlet: 'Youm7', url: 'https://x/1' }, { outlet: 'Masrawy', url: 'https://x/2' }],
};
// One item per lane, so all three section headers actually render.
const win = { id: 2, brand: 'Vodafone', headline: 'Top employer', summary: 's', sentiment: 'positive', importance: 3, category: 'brand', source: 'DNE', published_at: now, seen_at: now };
const rival = { id: 3, brand: 'e&', headline: 'Rival revenue up', summary: 's', sentiment: 'negative', importance: 2, category: 'competitor', source: 'Capital', published_at: now, seen_at: now };
// Every brand chip must actually RENDER here, or the retired-palette scan below
// passes for the wrong reason. `market` and `WE` were the two never exercised,
// and they were the two that had drifted.
const sector = { id: 4, brand: 'market', headline: 'Sector KYC failures', summary: 's', sentiment: 'negative', importance: 3, category: 'market', source: 'Al Mal', published_at: now, seen_at: now };
const we = { id: 5, brand: 'WE', headline: 'WE maintenance window', summary: 's', sentiment: 'neutral', importance: 2, category: 'network', source: 'Youm7', published_at: now, seen_at: now };
const bulletin = renderBulletin({ items: [item, win, rival, sector, we], broken: [], scanned: 5, greetingName: 'Team', variant: 'admin' });
const urgent = renderUrgent(item, 'https://pr-radar.example.com/');
// The sign-in email is a third surface on the same tokens — a person's first
// sight of the product, so it must not be the one that drifts.
const welcome = renderWelcome({ name: 'Tamer Basha', email: 'tamer.basha@vodafone.com', password: 'k7mpq-9xnrt-3tbwj-5hzvd-8fcgs-4ynkm', role: 'viewer', boardUrl: 'https://pr-radar.example.com/', support: 'ops@vodafone.com', subscribed: true });

for (const [name, html] of [['bulletin', bulletin], ['urgent', urgent], ['welcome', welcome]]) {
  // 2. The retired warm/taupe palette must not survive anywhere.
  for (const dead of ['#1a1214', '#3a2b28', '#6d605d', '#9a8d8a', '#a89b98', '#e7e2e0', '#faf8f7', '#e3d6d3', '#ead0cc', '#2a0606']) {
    assert.ok(!html.toLowerCase().includes(dead), `${name}: retired warm-palette colour ${dead} still present`);
  }
  // 3. The board's canvas + hairline are actually used.
  assert.ok(html.toLowerCase().includes(BOARD.bg), `${name}: uses the board canvas ${BOARD.bg}`);
  assert.ok(html.toLowerCase().includes(BOARD.hair), `${name}: uses the board hairline ${BOARD.hair}`);
  // 4. QUOTING GUARD: styles live inside double-quoted style="" attributes, so a
  //    double quote in the font stack truncates every declaration after it.
  assert.ok(!html.includes('"Segoe UI"'), `${name}: font stack must use single quotes inside style attributes`);
  assert.ok(html.includes("'Segoe UI'"), `${name}: system font stack present`);
  // 5. Every style attribute must be well-formed (no stray quote splitting it).
  for (const m of html.matchAll(/style="([^"]*)"/g)) {
    assert.ok(!/font-family:[^;]*$/.test(m[1]) || m[1].includes('sans-serif'),
      `${name}: a style attribute ends mid-font-family — quoting broke it: ${m[1].slice(-60)}`);
  }
  // 6. App vocabulary, not the old email-only wording.
  assert.ok(!/REPUTATIONAL READ/.test(html), `${name}: card block uses the board's wording`);
  assert.ok(!/>SEV</.test(html), `${name}: severity label reads "Impact" like the board`);
}
assert.ok(/What to do with this/i.test(bulletin), 'bulletin card uses the board\'s "What to do with this"');
assert.ok(/Impact/.test(bulletin), "bulletin uses the board's Impact label");
// board lane names, verbatim
for (const lane of ['Needs a response', 'Wins to amplify', 'Market &amp; noted']) {
  assert.ok(bulletin.includes(lane), `bulletin section named like the board lane: ${lane}`);
}

console.log('EMAIL-DESIGN OK — email theme equals the board tokens, warm palette gone, style attributes well-formed, board vocabulary (Impact / What to do with this / lane names)');
