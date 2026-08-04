// Admin → Tools → "Check account & template".
//
// WhatsApp error #132001 says "template does not exist in that language" for
// THREE different mistakes, and cannot tell them apart:
//   * the template is not approved yet
//   * the language code differs (en vs en_US)
//   * WHATSAPP_PHONE_ID belongs to a DIFFERENT WhatsApp Business Account from
//     the one the template lives on — templates do not transfer between
//     accounts, which is exactly what happens when a second WABA is created
// The sandbox has no route to graph.facebook.com, so the only way to tell is to
// ask Meta from production. This pins each verdict, and that the token is never
// echoed back to the browser.
import assert from 'node:assert';

process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.WHATSAPP_ENABLED = '1';
process.env.WHATSAPP_TOKEN = 'super-secret-token';
process.env.WHATSAPP_PHONE_ID = '111222333';
process.env.WHATSAPP_TO = '201000000000,201111111111';

const PHONE = { id: '111222333', display_phone_number: '+20 10 0000 0000', verified_name: 'PR Radar', quality_rating: 'GREEN' };
// The NUMBER's own review state, which Meta runs separately from the template.
let NAME_STATUS = 'APPROVED';
let TEMPLATES = [];
let SUBS = [];
let resolveWaba = true;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.includes('/rest/v1/pr_subscribers')) return { ok: true, status: 200, text: async () => JSON.stringify(SUBS) };
  if (u.includes('/rest/v1/')) return ok([]);
  if (!u.includes('graph.facebook.com')) throw new Error('unexpected fetch ' + u);
  // The token must travel in the header, never in the query string.
  assert.ok((opts.headers?.Authorization || '').includes(process.env.WHATSAPP_TOKEN), 'graph call is authorised');
  assert.ok(!u.includes(process.env.WHATSAPP_TOKEN), 'the token is never put in the URL');
  if (u.includes('whatsapp_business_account')) {
    return resolveWaba ? ok({ id: PHONE.id, whatsapp_business_account: { id: 'WABA_NEW', name: 'PR Radar' } })
      : { ok: false, status: 400, json: async () => ({ error: { message: 'nonexisting field', code: 100 } }), text: async () => '' };
  }
  if (u.includes('/message_templates')) return ok({ data: TEMPLATES });
  if (u.includes('name_status')) return ok({ name_status: NAME_STATUS, platform_type: 'CLOUD_API' });
  return ok(PHONE);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/admin.js');
const check = async () => {
  let out;
  const res = { status: () => res, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({ method: 'GET', query: { view: 'whatsapp-check' }, headers: { authorization: 'Bearer admin' } }, res);
  return out;
};

// ── the template is there and approved in the language we send ──
{
  TEMPLATES = [{ name: 'pr_urgent', language: 'en', status: 'APPROVED', category: 'UTILITY' }];
  const d = await check();
  assert.match(d.verdict, /^ready/, `an approved match reads ready (got "${d.verdict}")`);
  assert.strictEqual(d.state, 'ready', 'and is flagged ready for the UI to colour green');
  assert.strictEqual(d.waba.id, 'WABA_NEW', 'and names the account it checked');
  assert.strictEqual(d.phone.display_phone_number, '+20 10 0000 0000', 'the sender number is reported back');
  // The whole point of the diagnostic is to be pasteable — it must not leak.
  assert.ok(!JSON.stringify(d).includes(process.env.WHATSAPP_TOKEN), 'the token is never returned to the browser');
  // WHO gets paged, recognisable but not a directory of full mobile numbers:
  // the count answers "configured", not "the right people".
  assert.deepStrictEqual(d.config.recipients, ['20••••••0000', '20••••••1111'],
    `recipients are listed masked (got ${JSON.stringify(d.config.recipients)})`);
  for (const full of ['201000000000', '201111111111']) {
    assert.ok(!JSON.stringify(d).includes(full), `the full number ${full} is not exposed`);
  }
}

// ── approved, but under English (US) while we send "en" ──
// The single most likely cause once a template finally clears review.
{
  TEMPLATES = [{ name: 'pr_urgent', language: 'en_US', status: 'APPROVED', category: 'UTILITY' }];
  const d = await check();
  assert.strictEqual(d.state, 'error', 'a language mismatch IS something to fix');
  assert.match(d.verdict, /en_US \(APPROVED\)/, 'it names the language that DOES exist');
  assert.match(d.verdict, /WHATSAPP_TEMPLATE_LANG/, 'and the env var that fixes it');
}

// ── still in review, in the RIGHT language ──
// The live case on 3 Aug. The account, the name and the language were all
// already correct and the only thing missing was Meta's approval — but the
// verdict lumped this in with a language mismatch and told the admin to change
// WHATSAPP_TEMPLATE_LANG, sending them after a config problem that did not
// exist. "Not ready yet" and "you have something to fix" are different states.
{
  TEMPLATES = [{ name: 'pr_urgent', language: 'en', status: 'PENDING', category: 'UTILITY' }];
  const d = await check();
  assert.strictEqual(d.state, 'waiting', 'a pending review is its own state, not an error');
  assert.match(d.verdict, /PENDING/, 'the status is named');
  assert.match(d.verdict, /Nothing to fix/i, 'and the reader is told there is nothing to configure');
  assert.ok(!/Set WHATSAPP_TEMPLATE_LANG/.test(d.verdict),
    'it must NOT suggest changing the language when the language already matches');
}

// ── the number points at an account that has no such template ──
// This is the new-WABA case: templates do not move with you.
{
  TEMPLATES = [{ name: 'something_else', language: 'en', status: 'APPROVED', category: 'UTILITY' }];
  const d = await check();
  assert.match(d.verdict, /no template named "pr_urgent"/, 'a wrong-account phone id is named as such');
  assert.match(d.verdict, /do not transfer/, 'and explains why creating a new account loses them');
}

// ── the account cannot be resolved from the phone number ──
{
  resolveWaba = false;
  const d = await check();
  assert.strictEqual(d.waba, null, 'no account is invented when it cannot be resolved');
  assert.match(d.templatesError, /WHATSAPP_WABA_ID/, 'and the escape hatch is named');
  resolveWaba = true;
}

// ── BOTH lists are used, deduped ──
// WHATSAPP_TO used to OVERRIDE the subscriber list, so four numbers typed into
// Admin were silently ignored while the panel still read "1 recipient" — you
// could add four people and page none of them.
{
  SUBS = [{ whatsapp: '201000000005' }, { whatsapp: '201000000006' }, { whatsapp: '201000000000' }];
  TEMPLATES = [{ name: 'pr_urgent', language: 'en', status: 'APPROVED', category: 'UTILITY' }];
  const d = await check();
  assert.strictEqual(d.config.fromEnv, 2, 'the env numbers are counted');
  assert.strictEqual(d.config.fromSubscribers, 3, 'and the subscriber numbers are counted');
  // 2 env + 3 subs, but 201000000000 appears in both — messaged once, not twice.
  assert.strictEqual(d.config.recipients.length, 4,
    `the union is deduped (got ${JSON.stringify(d.config.recipients)})`);
  for (const tail of ['0000', '1111', '0005', '0006']) {
    assert.ok(d.config.recipients.some((r) => r.endsWith(tail)), `${tail} is in the list`);
  }
  SUBS = [];
}

// ── the admin TEST is scoped to WHATSAPP_TO, never the subscriber list ──
{
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/pr_subscribers')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ whatsapp: '201999999999' }]) };
    }
    if (u.includes('/messages')) { sent.push(JSON.parse(opts.body).to); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; }
    return realFetch(url, opts);
  };
  let out;
  const res = { status: () => res, json: (b) => { out = b; return res; }, setHeader() {}, end() {} };
  await handler({ method: 'POST', query: { resource: 'whatsapp-test' }, headers: { authorization: 'Bearer admin' } }, res);
  assert.deepStrictEqual(sent, ['201000000000', '201111111111'],
    `the test messages WHATSAPP_TO only (got ${JSON.stringify(sent)})`);
  assert.ok(!sent.includes('201999999999'), 'and never the subscriber list');

  // With WHATSAPP_TO empty the test refuses rather than quietly paging everyone.
  const keep = process.env.WHATSAPP_TO;
  delete process.env.WHATSAPP_TO;
  sent.length = 0;
  let out2;
  const res2 = { status: () => res2, json: (b) => { out2 = b; return res2; }, setHeader() {}, end() {} };
  await handler({ method: 'POST', query: { resource: 'whatsapp-test' }, headers: { authorization: 'Bearer admin' } }, res2);
  assert.match(out2.error, /WHATSAPP_TO/, 'it says which variable to set');
  assert.strictEqual(sent.length, 0, 'and sends nothing');
  process.env.WHATSAPP_TO = keep;
  globalThis.fetch = realFetch;
}

// ── nothing configured at all ──
{
  delete process.env.WHATSAPP_PHONE_ID;
  const d = await check();
  assert.match(d.error, /WHATSAPP_TOKEN and WHATSAPP_PHONE_ID/, 'missing config is reported plainly, not as a Meta error');
  process.env.WHATSAPP_PHONE_ID = '111222333';
}

// ── the template is APPROVED but the NUMBER's display name is not ──
// Live on 4 Aug: pr_urgent cleared review, the account resolved, the panel read
// "ready" — and every send failed #131037 because Meta reviews the sending
// number's display name separately. A verdict that says ready while nothing can
// send is worse than no verdict, so the number's state overrides the template's.
{
  TEMPLATES = [{ name: 'pr_urgent', language: 'en', status: 'APPROVED', category: 'UTILITY' }];
  NAME_STATUS = 'PENDING_REVIEW';
  const d = await check();
  assert.strictEqual(d.state, 'waiting', 'an unapproved display name is not "ready"');
  assert.match(d.verdict, /display name "PR Radar" is PENDING_REVIEW/, 'it names the display name and its state');
  assert.match(d.verdict, /#131037/, 'and the error code that will be seen until it clears');
  assert.match(d.verdict, /template is already approved/, 'while making clear the template half is done');
  assert.strictEqual(d.phone.name_status, 'PENDING_REVIEW', 'the raw status is reported for the panel to colour');
}

// ── a REAL problem still wins over the display name ──
// A missing template is something to fix now; a name in review is a wait. If
// the wait masked the fix, the admin would sit watching the wrong thing.
{
  TEMPLATES = [];
  NAME_STATUS = 'PENDING_REVIEW';
  const d = await check();
  assert.strictEqual(d.state, 'error', 'a missing template is still an error, not a wait');
  assert.match(d.verdict, /no template named/, 'and the template problem is what gets named');
}

// ── both approved → ready ──
{
  TEMPLATES = [{ name: 'pr_urgent', language: 'en', status: 'APPROVED', category: 'UTILITY' }];
  NAME_STATUS = 'APPROVED';
  const d = await check();
  assert.strictEqual(d.state, 'ready', 'name approved + template approved = ready');
}

console.log('WHATSAPP-CHECK OK — the diagnostic separates the three causes of #132001 (not approved / wrong language / template lives on another account), names the fix for each, separates a template problem from a display name still in review (#131037), resolves the account from the phone number with WHATSAPP_WABA_ID as a fallback, and never returns the token');
