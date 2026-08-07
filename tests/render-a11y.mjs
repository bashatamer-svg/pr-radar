// Accessible names and live regions.
//
// Two problems, both invisible to a sighted user and total to anyone else:
//
//  1. ICON-ONLY CONTROLS relied on `title`. A card footer offered 📸 🔔 📌 🙈
//     ▲ ▼ and an admin row ✎ ✕, with the meaning only in a tooltip — and
//     `title` is not an accessible name a screen reader announces reliably,
//     nor one a touch user can ever see. Six of the eight controls on an
//     admin's board card were unlabelled, which is the whole card.
//
//  2. STATUS MESSAGES were plain divs. "Report opened in a new tab", "the email
//     did NOT send", "Password must be at least 8 characters" all appeared
//     silently: the reader submits, nothing is announced, and the only feedback
//     is text they are not looking at.
//
// The rule this pins: a control whose visible text contains no letters needs an
// aria-label, and a region that reports the result of an action needs a live
// role. Enforced across every page, so a new one cannot skip it.
import assert from 'node:assert';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const DIR = new URL('..', import.meta.url).pathname + 'public';
const PAGES = readdirSync(DIR).filter((f) => f.endsWith('.html'));

/* ── 1. no icon-only control is left without a name ─────────────────────── */
// Source-level, because the board's controls are built inside template strings
// that only exist once a card renders.
{
  const missing = [];
  for (const f of PAGES) {
    const html = readFileSync(`${DIR}/${f}`, 'utf8');
    for (const m of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attrs = m[2];
      // Visible text, with markup removed and template holes resolved as far
      // as they can be: a hole containing a quoted literal — `${x?'Unpin':'Pin
      // for the team'}` — renders as words, so stripping it wholesale would
      // report a perfectly-labelled control as icon-only.
      const text = m[3]
        .replace(/<[^>]+>/g, '')
        .replace(/\$\{[^}]*\}/g, (h) => (/['"`][^'"`]*[A-Za-z]{3}/.test(h) ? 'text' : ''))
        .trim();
      if (!text) continue;
      // Letters in any script the app uses (Latin or Arabic) = it names itself.
      if (/[A-Za-z؀-ۿ]/.test(text)) continue;
      if (/aria-label\s*=/.test(attrs)) continue;
      if (/aria-labelledby\s*=/.test(attrs)) continue;
      missing.push(`${f}: ${text.slice(0, 8)} — ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    `icon-only controls with no accessible name (title= is not one):\n  ${missing.join('\n  ')}`);
}

// And the labels have to SAY something. "Button", "Click", the emoji itself or
// a two-character label is a label that passes a linter and helps nobody.
{
  for (const f of PAGES) {
    const html = readFileSync(`${DIR}/${f}`, 'utf8');
    for (const m of html.matchAll(/aria-label="([^"]*)"/g)) {
      const label = m[1].replace(/\$\{[^}]*\}/g, '').trim();
      assert.ok(label.length >= 4, `${f}: aria-label "${m[1]}" is too short to mean anything`);
      assert.ok(!/^(button|click|link|icon)$/i.test(label), `${f}: aria-label "${label}" says nothing`);
    }
  }
}

/* ── 2. toggles report their state, not just their name ─────────────────── */
{
  const board = readFileSync(`${DIR}/index.html`, 'utf8');
  // These four moved into the ••• More menu, where they are LABELLED rows
  // rather than bare icons — so the accessible name is their visible text and
  // an aria-label would be a second, competing one.
  for (const cls of ['mitem pin', 'mitem hide', 'mitem up', 'mitem down']) {
    const m = board.match(new RegExp(`<button class="${cls}"[^>]*>`));
    assert.ok(m, `the ${cls} control exists`);
    assert.match(m[0], /aria-pressed=/, `${cls} announces whether it is currently on`);
  }
  // The menu button itself IS icon-only, so it needs the full set.
  const more = board.match(/<button class="fb morebtn"[\s\S]*?>/)[0];
  assert.match(more, /aria-haspopup="true"/, 'the ••• button announces that it opens a menu');
  assert.match(more, /aria-expanded="false"/, 'and whether it is currently open');
  assert.match(more, /aria-label=/, 'and what it is');
}

/* ── 3. status regions are live ─────────────────────────────────────────── */
{
  const missing = [];
  for (const f of PAGES) {
    const html = readFileSync(`${DIR}/${f}`, 'utf8');
    // Every region this app writes a result into.
    for (const m of html.matchAll(/<(div|span)\b[^>]*\b(class="(formmsg|msg|status)[^"]*"|id="(msg|uOut|status)")[^>]*>/g)) {
      if (/role="(status|alert)"/.test(m[0])) continue;
      // `.msg.show` variants inside template strings are the same node.
      missing.push(`${f}: ${m[0].slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(missing, [],
    `status regions with no live role — a result nobody hears:\n  ${missing.join('\n  ')}`);

  // POLITE, not assertive, and that is a decision rather than a default. Every
  // one of these follows a submit the reader is already waiting on, so it
  // should announce at the next pause — assertive interrupts a screen reader
  // mid-sentence, and a page where every outcome does that is a page whose
  // announcements get turned off.
  for (const f of PAGES) {
    const html = readFileSync(`${DIR}/${f}`, 'utf8');
    for (const m of html.matchAll(/aria-live="(\w+)"/g)) {
      assert.strictEqual(m[1], 'polite', `${f}: live regions are polite, not ${m[1]}`);
    }
    assert.ok(!/role="alert"/.test(html), `${f}: nothing here is urgent enough to interrupt`);
  }
}

/* ── 4. in a browser: the names are what a reader actually gets ─────────── */
{
  const now = new Date().toISOString();
  const items = [{ id: 1, brand: 'Vodafone', headline: 'Vodafone Cash outage angers users', summary: 's',
    sentiment: 'negative', importance: 5, category: 'vodafone_cash', url: 'https://y.example/a',
    resolved_url: 'https://y.example/a', published_at: now, source: 'Youm7', instances: [] }];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/api/items') return j(items);
    if (u.pathname === '/api/auth') {
      if (u.searchParams.get('view') === 'config') return j({ supabaseUrl: '', anonKey: '' });
      return j({ email: 'admin@vodafone.com', role: 'admin', kind: 'user' });
    }
    if (u.pathname.startsWith('/api/')) return j([]);
    const f = u.pathname === '/' ? '/index.html' : u.pathname === '/login' ? '/login.html' : u.pathname;
    try {
      const b = readFileSync(DIR + f);
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
  });
  await new Promise((r) => server.listen(8961, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('pr_session', JSON.stringify({ access_token: 'admin-token', refresh_token: 'r' })));
  await page.goto('http://localhost:8961/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#item-1 .foot', { timeout: 5000 });

  // Every control in the admin card footer resolves to a real accessible name.
  // Computed from the DOM, not read from the source, so an aria-label that is
  // present but overridden (or a control that renders without one) fails here.
  // DIRECT children only: the four items inside the ••• menu are descendants of
  // .foot too, and counting them would make "how many controls does an admin
  // face at once" meaningless — which is the number this change exists to move.
  const names = await page.$$eval('#item-1 .foot > button, #item-1 .foot > a, #item-1 .foot > .more > button', (els) => els.map((e) => ({
    text: e.textContent.trim().slice(0, 14),
    name: (e.getAttribute('aria-label') || e.textContent).trim(),
  })));
  // Five now, not eight: Copy · 📸 · 🔔 · ••• · Open source. The other four
  // moved into the menu — see render-card-foot, which proves they are still
  // reachable and still work.
  assert.strictEqual(names.length, 5, `an admin sees five primary controls (got ${names.length})`);
  for (const n of names) {
    assert.ok(/[A-Za-z]{4}/.test(n.name), `the "${n.text}" control has a readable name, got "${n.name}"`);
  }
  // The two that mean the most and read the least: pin and hide.
  await page.click('#item-1 .morebtn');
  const pin = await page.$eval('#item-1 .mitem.pin', (e) => ({ name: e.textContent.trim(), pressed: e.getAttribute('aria-pressed') }));
  assert.match(pin.name, /Pin for the team/i, 'the pin item announces what it does, in words');
  assert.strictEqual(pin.pressed, 'false', 'and that it is currently off');
  await page.click('#item-1 .mitem.pin');
  await page.waitForTimeout(200);
  await page.click('#item-1 .morebtn');
  const after = await page.$eval('#item-1 .mitem.pin', (e) => ({ name: e.textContent.trim(), pressed: e.getAttribute('aria-pressed') }));
  assert.strictEqual(after.pressed, 'true', 'and the announced state follows the actual state');
  assert.match(after.name, /Unpin/i, 'and so does the LABEL — "Pin" while already pinned would be a lie');

  // The board's status line is live, so "showing 1 story" is heard rather than
  // only seen.
  const st = await page.$eval('#status', (e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: e.textContent }));
  assert.strictEqual(st.role, 'status');
  assert.strictEqual(st.live, 'polite');
  assert.ok(st.text.trim().length > 0, 'and it actually says something');

  // Keyboard: every footer control is reachable. A control that can only be
  // clicked is not a control for a keyboard user.
  const focusable = await page.$$eval('#item-1 .foot > button, #item-1 .foot > a, #item-1 .foot > .more > button',
    (els) => els.filter((e) => e.tabIndex >= 0).length);
  assert.strictEqual(focusable, names.length, 'every footer control is keyboard-reachable');

  await page.close();
  await browser.close();
  server.close();
}

console.log('A11Y OK — no icon-only control is left with only a title; labels say something; the four toggles announce name AND state; every result region is a polite live region (never assertive, which would interrupt); and in a real browser the computed names, the state after a click, and keyboard reachability all hold');
