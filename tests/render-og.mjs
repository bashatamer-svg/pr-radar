// Link previews & branding: every public page carries Open Graph + Twitter
// card tags and the favicon links, and the referenced images exist as real
// PNGs at the right sizes (regenerate with: node scripts/make-og.mjs).
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../public/', import.meta.url).pathname;
const pages = readdirSync(DIR).filter((f) => f.endsWith('.html'));
assert.ok(pages.length >= 8, `expected all pages, got ${pages.length}`);

for (const f of pages) {
  const html = readFileSync(DIR + f, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  for (const tag of [
    'property="og:type" content="website"',
    'property="og:site_name" content="PR Radar"',
    'property="og:title"',
    'property="og:description"',
    'property="og:image" content="/og-card.png"',
    'name="twitter:card" content="summary_large_image"',
    'rel="icon" type="image/png" href="/icon.png"',
    'rel="apple-touch-icon"',
  ]) assert.ok(head.includes(tag), `${f}: missing ${tag}`);
  // static tags must never leak live coverage data or tokens
  assert.ok(!/[?&]t=/.test(head), `${f}: token in head`);
  const title = /property="og:title" content="([^"]+)"/.exec(head)[1];
  assert.ok(/PR Radar/.test(title), `${f}: og:title not branded (${title})`);
}

// PNG assets: correct magic bytes + IHDR dimensions
const png = (name) => {
  const b = readFileSync(DIR + name);
  assert.strictEqual(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${name}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const cardDim = png('og-card.png');
assert.deepStrictEqual(cardDim, { w: 1200, h: 630 }, 'og-card is 1200×630');
const iconDim = png('icon.png');
assert.deepStrictEqual(iconDim, { w: 180, h: 180 }, 'icon is 180×180');

console.log(`OG OK — ${pages.length} pages tagged (og + twitter + favicon), og-card.png 1200×630 + icon.png 180×180 valid`);
