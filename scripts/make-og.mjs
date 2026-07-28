// Generates the static share/branding images from HTML — run once (or after a
// redesign) with:  node scripts/make-og.mjs
// Uses headless Chromium via playwright-core (already a devDependency for the
// browser tests) so the repo takes on no image libraries.
//
//   public/og-card.png  1200×630  — Open Graph / Twitter link-preview card
//   public/icon.png      180×180  — favicon + apple-touch-icon
import { chromium } from 'playwright-core';

const RED = '#e60000';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

// Radar rings + sweep, echoing the board's animated mark — static here.
const rings = (cx, cy, rs, op) => rs.map((r) =>
  `<div style="position:absolute;left:${cx - r}px;top:${cy - r}px;width:${2 * r}px;height:${2 * r}px;border:2px solid rgba(255,255,255,${op});border-radius:50%;"></div>`).join('');

// Designed for the THUMBNAIL, not the full-size image: huge headline, ONE
// secondary line at 40px+, no body copy (the og:description carries the
// tagline — repeating it on the card read twice in WhatsApp). Rings are
// strong enough to survive downscale, and the blip sits ON a ring under a
// sweep-glow so it reads as radar, not a stray speck.
const card = `<!DOCTYPE html><html><body style="margin:0;width:1200px;height:630px;overflow:hidden;">
<div style="position:relative;width:1200px;height:630px;background:${RED};font-family:${FONT};overflow:hidden;">
  ${rings(600, 315, [150, 260, 380, 520], 0.2)}
  <div style="position:absolute;left:860px;top:37px;width:18px;height:18px;background:#fff;border-radius:50%;
              box-shadow:0 0 0 10px rgba(255,255,255,.18), 0 0 34px 12px rgba(255,255,255,.35);"></div>
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px;">
    <div style="display:flex;align-items:center;gap:44px;">
      <div style="width:180px;height:180px;background:#fff;border-radius:42px;display:grid;place-items:center;
                  font-size:74px;font-weight:800;color:${RED};letter-spacing:-.02em;box-shadow:0 20px 70px rgba(0,0,0,.28);">PR</div>
      <div style="font-size:138px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1;text-shadow:0 4px 30px rgba(0,0,0,.18);">PR Radar</div>
    </div>
    <div style="font-size:38px;color:rgba(255,255,255,.95);letter-spacing:.08em;font-weight:700;white-space:nowrap;">BRAND &amp; REPUTATION &nbsp;·&nbsp; VODAFONE EGYPT</div>
  </div>
  <div style="position:absolute;left:0;bottom:0;width:1200px;height:16px;background:rgba(0,0,0,.18);"></div>
</div></body></html>`;

const icon = `<!DOCTYPE html><html><body style="margin:0;width:180px;height:180px;">
<div style="position:relative;width:180px;height:180px;background:${RED};font-family:${FONT};overflow:hidden;">
  ${rings(90, 90, [55, 80], 0.25)}
  <div style="position:absolute;inset:0;display:grid;place-items:center;font-size:74px;font-weight:800;color:#fff;letter-spacing:-.02em;">PR</div>
</div></body></html>`;

const OUT = new URL('../public/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const [name, html, width, height] of [['og-card.png', card, 1200, 630], ['icon.png', icon, 180, 180]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: OUT + name });
  await page.close();
  console.log(`wrote public/${name} (${width}×${height})`);
}
await browser.close();
