// Test runner — runs every test in this folder, each in its own process (tests
// mock globalThis.fetch and mutate env, so isolation is required).
//
//   npm test                → run everything
//   npm test -- lanes       → run only tests whose filename contains "lanes"
//
// Browser (Playwright) tests need a Chromium binary: set CHROMIUM_PATH, or the
// default Vercel-sandbox path is tried. No test touches the network or a real
// database — everything is mocked — so the suite is safe to run against any
// checkout.
//
// SKIPPING IS A LOCAL CONVENIENCE, NOT A CI OUTCOME. Without a browser those
// tests are skipped so the unit suite still runs on a laptop that has no
// Chromium — but roughly half this suite is browser tests, including every
// mobile-layout regression and the CSP proof, and a green run that quietly
// exercised none of them is worse than a red one. So when CI=true (which every
// CI provider sets, and .github/workflows/ci.yml sets explicitly), a skip is a
// FAILURE and the run exits non-zero naming what did not execute.
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

// Truthy CI env var → a skipped browser test is a failed run.
const STRICT = /^(1|true|yes)$/i.test(String(process.env.CI || ''));

let pass = 0, fail = 0, skip = 0;
const failed = [], skipped = [];
for (const f of files) {
  const isBrowser = readFileSync(DIR + f, 'utf8').includes('playwright-core');
  if (isBrowser && !havePw) { console.log(`SKIP  ${f}`); skip++; skipped.push(f); continue; }
  const t0 = Date.now();
  const r = spawnSync('node', [DIR + f], { timeout: 180000, encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (ok) pass++;
  else {
    fail++; failed.push(f);
    // WHICH END OF THE OUTPUT YOU PRINT DECIDES WHETHER A CI FAILURE IS
    // DIAGNOSABLE. This was the last 12 lines of stdout+stderr concatenated —
    // and Node puts the error MESSAGE at the top of stderr and a long object
    // dump (`generatedMessage`, `code`, `log: [...]`, `name`) at the bottom, so
    // the tail is the one part that says nothing. A real CI failure (8 Aug,
    // render-board-sort) logged `name: 'Error'` and a line number, with no
    // message anywhere — undiagnosable from the log, which means re-run rather
    // than fix, which is how a flake becomes permanent.
    //
    // So: the HEAD of stderr, where the message and its source line are, and
    // the TAIL of stdout, which is how far the test actually got.
    // Node's uncaught-exception preamble and its own internal stack frames are
    // the same three or four lines every time and never name anything in this
    // repo — dropping them is what makes room for the message itself.
    const NOISE = /^(node:internal\/|\s*triggerUncaughtException\(|\s*\^\s*$|\s*at node:internal\/)/;
    const lines = (s) => String(s || '').trimEnd().split('\n').filter((l) => l.trim());
    for (const line of lines(r.stdout).slice(-4)) console.log('      · ' + line);
    for (const line of lines(r.stderr).filter((l) => !NOISE.test(l)).slice(0, 18)) console.log('      ' + line);
    // A test killed by the runner's own 180s cap exits with no output at all,
    // which reads exactly like a test that printed nothing — say which it was.
    if (r.error) console.log(`      runner: ${r.error.message}`);
    if (r.signal) console.log(`      killed by ${r.signal} (the runner's 180s per-file cap)`);
  }
}
console.log(`\n${pass} passed · ${fail} failed · ${skip} skipped · ${files.length} total`);
if (failed.length) console.log('failed:', failed.join(', '));
if (skipped.length && STRICT) {
  console.log(`\nCI=${process.env.CI}: ${skipped.length} browser test(s) did NOT run — ${skipped.join(', ')}`);
  console.log('A release gate that silently skips half the suite is not a gate.');
  console.log(`Install Chromium (or set CHROMIUM_PATH); the runner looked at ${chrome}.`);
}
if (failed.length || (skipped.length && STRICT)) process.exit(1);
