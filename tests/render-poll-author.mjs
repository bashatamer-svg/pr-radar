// The 30-min urgent poll now captures authors AT INGEST: resolve the Google-News
// wrapper → fetch the publisher page → extract the byline → insert the row WITH
// author + resolved_url (previously skipped, leaving fresh cards "—" until the
// next 05:00 daily backfill). Full handler run, everything mocked.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'ak';
process.env.BOARD_URL = 'https://pr.example/';
// RADAR_TO / URGENT_WEBHOOK_URL / WHATSAPP_* unset → all alert channels no-op/fail-soft.

const STORY = 'شكوى تضارب ردود بنك مصر وفودافون كاش بعد خصم مبلغ من ماكينة';
const WRAP = 'https://news.google.com/rss/articles/CBMiTESTWRAP';
const PUB = 'https://alhoria.example/atm-complaint/';
const RSS = `<?xml version="1.0"?><rss><channel><item><title>${STORY} - موقع الحرية</title><link>${WRAP}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
// Publisher page: byline in the common Arabic form the deterministic cascade catches.
const PAGE = `<html><body><h1>${STORY}</h1><div>كتب : أحمد سامي</div><p>تفاصيل الشكوى المقدمة من العميل بعد خصم المبلغ دون صرفه من الماكينة.</p></body></html>`;

let insertedRows = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET';
  const ok = (body, extra = {}) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body), ...extra });
  if (u.includes('news.google.com/rss/search')) return ok(RSS);
  // the wrapper "redirect-follows" to the publisher (resolveUrl strategy A reads res.url)
  if (u.includes('news.google.com/rss/articles/')) return ok(PAGE, { url: PUB });
  if (u.includes('alhoria.example')) return ok(PAGE, { url: PUB });
  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body);
    if (/AUTHOR BYLINE/.test(body.system || '')) return ok(JSON.stringify({ content: [{ type: 'text', text: '{"author":null}' }] }));
    // classify: one relevant negative Vodafone item, importance 5
    return ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([{ i: 0, is_relevant: true, brand: 'Vodafone', sentiment: 'negative', country: 'Egypt', category: 'vodafone_cash', summary: 'ATM deduction complaint', pr_angle: 'Read · x\nAudience · y\nAction · monitor', importance: 5, confidence: 0.9, deadline: null, reason: null }]) }] }));
  }
  if (u.includes('/rest/v1/pr_items') && u.includes('select=hash')) return ok('[]');   // nothing seen → candidate flows
  if (u.includes('/rest/v1/pr_items') && m === 'POST') { insertedRows = JSON.parse(opts.body); return ok(JSON.stringify(insertedRows.map((r, i) => ({ ...r, id: i + 1 })))); }
  if (u.includes('/rest/v1/pr_instances') && m === 'POST') return ok('');
  if (u.includes('/rest/v1/pr_feed_health')) return ok(m === 'POST' ? '' : '[]');
  if (u.includes('api.resend.com')) return ok('{"id":"x"}');
  if (u.includes('/rest/v1/')) return ok('[]');
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/radar.js');
let code, body;
const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {}, send() {} };
await handler({ query: { urgentOnly: '1' }, headers: { authorization: 'Bearer tok' } }, res);

assert.strictEqual(code, 200, 'urgent poll returns 200');
assert.ok(Array.isArray(insertedRows) && insertedRows.length === 1, 'the fresh story was inserted');
const row = insertedRows[0];
assert.strictEqual(row.author, 'أحمد سامي', `author captured AT INGEST on the urgent poll (got ${JSON.stringify(row.author)})`);
assert.strictEqual(row.resolved_url, PUB, 'publisher URL resolved + stored at ingest too');
assert.ok(!('reason' in row), 'insert key set still clean (no reason)');
console.log('POLL-AUTHOR OK — the 30-min urgent poll resolves the wrapper, extracts the byline (كتب : أحمد سامي) and inserts the row WITH author + resolved_url; no more 17h author gap');
