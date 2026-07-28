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

const card = `<!DOCTYPE html><html><body style="margin:0;width:1200px;height:630px;overflow:hidden;">
<div style="position:relative;width:1200px;height:630px;background:${RED};font-family:${FONT};overflow:hidden;">
  ${rings(1040, 120, [90, 170, 260, 360], 0.14)}
  <div style="position:absolute;left:1035px;top:115px;width:10px;height:10px;background:#fff;border-radius:50%;opacity:.9;"></div>
  <div style="position:absolute;left:90px;top:150px;display:flex;align-items:center;gap:34px;">
    <div style="width:150px;height:150px;background:#fff;border-radius:34px;display:grid;place-items:center;
                font-size:60px;font-weight:800;color:${RED};letter-spacing:-.02em;box-shadow:0 18px 60px rgba(0,0,0,.25);">PR</div>
    <div>
      <div style="font-size:104px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1;">PR Radar</div>
      <div style="font-size:26px;color:rgba(255,255,255,.85);letter-spacing:.24em;font-weight:600;margin-top:18px;">BRAND &amp; REPUTATION &nbsp;·&nbsp; VODAFONE EGYPT</div>
    </div>
  </div>
  <div style="position:absolute;left:90px;bottom:96px;font-size:28px;color:rgba(255,255,255,.92);font-weight:600;line-height:1.6;">
    <div style="white-space:nowrap;">Daily press &amp; media monitor — coverage, sentiment and share of voice,</div>
    <div style="white-space:nowrap;">classified and briefed for the PR &amp; Communications team.</div>
  </div>
  <div style="position:absolute;left:0;bottom:0;width:1200px;height:14px;background:rgba(0,0,0,.18);"></div>
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
