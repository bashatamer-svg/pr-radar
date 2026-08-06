// Test runner — runs every test in this folder, each in its own process (tests
// mock globalThis.fetch and mutate env, so isolation is required).
//
//   npm test                → run everything
//   npm test -- lanes       → run only tests whose filename contains "lanes"
//
// Browser (Playwright) tests need a Chromium binary: set CHROMIUM_PATH, or the
// default Vercel-sandbox path is tried. If Chromium or playwright-core is
// missing, browser tests are SKIPPED (not failed) so the unit suite still runs
// anywhere. No test touches the network or a real database — everything is
// mocked — so the suite is safe to run against any checkout.
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DIR = new URL('.', import.meta.url).pathname;
mkdirSync(DIR + 'out', { recursive: true });

const EXCLUDE = new Set(['run.mjs', 'narr-fixture.mjs', 'byline-cases.mjs']);
const filter = process.argv[2] || '';
const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs') && !EXCLUDE.has(f) && f.includes(filter)).sort();

const chrome = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let havePw = existsSync(chrome);
if (havePw) {
  try { createRequire(import.meta.url).resolve('playwright-core'); }
  catch { havePw = false; console.log('note: playwright-core not installed (npm install) — browser tests will be skipped'); }
} else if (files.some((f) => readFileSync(DIR + f, 'utf8').includes('playwright-core'))) {
  console.log(`note: Chromium not found at ${chrome} (set CHROMIUM_PATH) — browser tests will be skipped`);
}

let pass = 0, fail = 0, skip = 0;
const failed = [];
for (const f of files) {
  const isBrowser = readFileSync(DIR + f, 'utf8').includes('playwright-core');
  if (isBrowser && !havePw) { console.log(`SKIP  ${f}`); skip++; continue; }
  const t0 = Date.now();
  const r = spawnSync('node', [DIR + f], { timeout: 180000, encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (ok) pass++;
  else {
    fail++; failed.push(f);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n');
    for (const line of out.slice(-12)) console.log('      ' + line);
  }
}
console.log(`\n${pass} passed · ${fail} failed · ${skip} skipped · ${files.length} total`);
if (failed.length) { console.log('failed:', failed.join(', ')); process.exit(1); }
