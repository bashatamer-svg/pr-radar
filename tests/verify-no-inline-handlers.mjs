// No HTML event-handler attributes, anywhere, on any page.
//
// This is the half of `script-src 'unsafe-inline'` that cannot be hashed away.
// An inline <script> block has a stable SHA-256 you can name in the header; an
// `onclick="…"` attribute does not — allowing those needs 'unsafe-inline' (or
// 'unsafe-hashes' plus a hash per handler, which is unmaintainable at 25 of
// them). So dropping 'unsafe-inline' requires this file to stay at zero.
//
// They were also a live bug, independent of CSP. The arguments were JS SOURCE
// embedded in an HTML attribute:
//
//     onclick="removeUser(${u.id},'${esc(u.email)}')"
//
// and admin's `esc()` escapes < > & and " but NOT an apostrophe. So
// o'brien@example.com produced `removeUser(7,'o'brien@example.com')` — a
// syntax error, and a button that silently did nothing. Six admin controls
// carried an email that way. In a `data-` attribute, escaping " is enough.
//
// What this pins:
//   1. no `on*="…"` attribute in any public page, either quote style
//   2. no `javascript:` URL
//   3. no inline <script> in the GENERATED print document — a blob: document
//      inherits the opener's CSP, so one there is the same problem
//   4. every data-act a page emits has a handler, and every handler is used —
//      a typo in either direction is a dead button, which is precisely the
//      failure this refactor is supposed to have removed
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert';

const DIR = new URL('../public/', import.meta.url).pathname;
const pages = readdirSync(DIR).filter((f) => f.endsWith('.html'));
assert.ok(pages.length >= 7, `found the pages (${pages.length})`);

/* ── 1. no event-handler attributes ──────────────────────────────────────── */
// Matches `onclick="` / `onclick='` but not `.onclick=` or `el.onclick =`,
// which are JS property assignments and perfectly fine under any CSP.
const ATTR = /(^|[\s"'`{])(on[a-z]+)\s*=\s*["']/gi;
for (const f of pages) {
  const html = readFileSync(DIR + f, 'utf8');
  // Strip comments first — this file's own explanation quotes the old shape.
  const stripped = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const hits = [...stripped.matchAll(ATTR)]
    .filter((m) => !/\.\s*$/.test(stripped.slice(Math.max(0, m.index - 2), m.index + 1)))
    .map((m) => m[2]);
  assert.deepStrictEqual(hits, [],
    `${f}: inline event-handler attribute(s) ${hits.join(', ')} — these cannot be hashed, so they force script-src 'unsafe-inline'. Use data-act + the page's delegated listener.`);
}

/* ── 2. no javascript: URLs ──────────────────────────────────────────────── */
for (const f of pages) {
  const html = readFileSync(DIR + f, 'utf8')
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(html),
    `${f}: a javascript: URL is inline script by another name`);
}

/* ── 3. the generated print document carries no inline script ────────────── */
// It is opened as a blob:, which INHERITS this page's CSP.
{
  const stats = readFileSync(DIR + 'stats.html', 'utf8');
  const printDoc = stats.slice(stats.indexOf('function printDoc'), stats.indexOf('function saveBlob'));
  assert.ok(printDoc.length > 200, 'found printDoc');
  assert.ok(!/<script/i.test(printDoc),
    'stats.html: the generated print document must not contain an inline <script> — a blob: document inherits the opener CSP, so it would need unsafe-inline just like the page');
  assert.ok(/w\.print\(\)/.test(stats),
    'the print is driven from the opener instead, so the dialog still opens');
}

/* ── 4. every emitted data-act is handled, and every handler is emitted ──── */
for (const [f, table] of [['index.html', 'ACTS'], ['admin.html', 'ADMIN_ACTS']]) {
  const html = readFileSync(DIR + f, 'utf8');
  const emitted = new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]));
  const block = html.slice(html.indexOf(`const ${table} = {`));
  const handled = new Set(
    [...block.slice(0, block.indexOf('};')).matchAll(/^\s*'?([a-z-]+)'?\s*:/gm)].map((m) => m[1]),
  );
  assert.ok(emitted.size >= 8, `${f}: found the emitted actions (${emitted.size})`);
  for (const a of emitted) {
    assert.ok(handled.has(a), `${f}: markup emits data-act="${a}" with no entry in ${table} — a dead button`);
  }
  for (const a of handled) {
    assert.ok(emitted.has(a), `${f}: ${table} handles "${a}" but nothing emits it — a stale entry`);
  }
}

console.log(`NO-INLINE-HANDLERS OK — ${pages.length} pages carry zero on*="…" attributes and zero javascript: URLs, the generated print document has no inline script (it inherits the opener's CSP), and every data-act emitted by the board and admin has exactly one handler in its delegation table, in both directions`);
