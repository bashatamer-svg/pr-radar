// Custom date-range reports (/api/report?from=&to=) — the /reports builder's
// backend. Verifies: viewer auth, exec summary + coverage-log appendix on the
// range view, Word (.doc) export envelope, range validation 400s, the
// admin-only email gate, and that the plain weekly view stays appendix-free.
import assert from 'node:assert';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RADAR_TOKEN = 'tok';     // → service viewer
process.env.CRON_SECRET = 'cron';    // → service admin
process.env.BOARD_URL = 'https://pr-radar.example.com/';

const now = '2026-07-03T10:00:00Z';
const items = [
  { id: 1, brand: 'Vodafone', headline: 'Vodafone Cash outage angers users', summary: 's', sentiment: 'negative', importance: 5, category: 'vodafone_cash', source: 'Youm7', author: 'Ahmed Ali', url: 'https://news/1', resolved_url: 'https://news/1', pr_angle: 'p', published_at: now, seen_at: now },
  { id: 2, brand: 'Vodafone', headline: 'Vodafone wins network award', summary: 's', sentiment: 'positive', importance: 3, category: 'brand', source: 'Ahram', author: null, url: 'https://news/2', resolved_url: '', pr_angle: '', published_at: now, seen_at: now },
  { id: 3, brand: 'Orange', headline: 'Orange billing glitch', summary: 's', sentiment: 'negative', importance: 4, category: 'billing', source: 'Masrawy', author: null, url: 'https://news/3', resolved_url: '', pr_angle: '', published_at: now, seen_at: now },
  { id: 4, brand: 'market', headline: 'NTRA announces new spectrum auction', summary: 's', sentiment: 'neutral', importance: 3, category: 'regulatory', source: 'Ahram', author: null, url: 'https://news/4', resolved_url: '', pr_angle: '', published_at: now, seen_at: now },
];
const prevItems = [items[2]]; // lighter prior window → deltas are non-zero

// rest() mock: the range fetch asks for FULL cols (headline present in select)
// for the current window and LEAN cols for the prior one.
globalThis.fetch = async (url) => {
  const u = String(url);
  let rows = [];
  if (u.includes('/pr_instances')) rows = [];
  else if (u.includes('/pr_items')) rows = u.includes('headline') ? items : prevItems;
  return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
};

const { default: handler } = await import(new URL('..', import.meta.url).pathname + '/api/report.js');
const call = async (query, headers = {}) => {
  let code = 200, body, sent, hdrs = {};
  const res = {
    status: (c) => { code = c; return res; },
    json: (b) => { body = b; return res; },
    send: (s) => { sent = s; return res; },
    setHeader: (k, v) => { hdrs[k.toLowerCase()] = v; },
  };
  await handler({ query, headers }, res);
  return { code, body, sent, hdrs };
};

// ── auth: no bearer → 401 ──
assert.strictEqual((await call({ from: '2026-07-01', to: '2026-07-07' })).code, 401);

// ── range view (viewer): exec summary + appendix + methodology ──
const asViewer = { authorization: 'Bearer tok' };
let r = await call({ from: '2026-07-01', to: '2026-07-07' }, asViewer);
assert.strictEqual(r.code, 200);
assert.ok(/text\/html/.test(r.hdrs['content-type']), 'HTML view');
assert.ok(r.sent.includes('Coverage report'), 'custom title');
assert.ok(r.sent.includes('Executive summary'), 'exec summary present');
assert.ok(r.sent.includes('Appendix — coverage log'), 'coverage-log appendix present');
assert.ok(r.sent.includes('Methodology'), 'methodology note present');
assert.ok(r.sent.includes('Vodafone Cash outage angers users'), 'story in the log');
assert.ok(r.sent.includes('Ahmed Ali'), 'byline shown when known');
assert.ok(r.sent.includes('newsroom'), 'authorless rows fall back to newsroom');
assert.ok(r.sent.includes('1 Jul') && r.sent.includes('7 Jul 2026'), 'range label names both dates');

// coverage log is grouped by operator, then the wider market
const iVod = r.sent.indexOf('Vodafone&nbsp;<span');
const iOrg = r.sent.indexOf('Orange&nbsp;<span');
const iMkt = r.sent.indexOf('Market &amp; sector&nbsp;<span');
assert.ok(iVod >= 0 && iOrg >= 0 && iMkt >= 0, 'operator + market group headers present');
assert.ok(iVod < iOrg && iOrg < iMkt, 'groups ordered: Vodafone → Orange → Market');
assert.ok(r.sent.indexOf('Vodafone Cash outage angers users') < iOrg, 'Vodafone stories inside the Vodafone group');
assert.ok(r.sent.indexOf('NTRA announces new spectrum auction') > iMkt, 'sector story lands under Market & sector');
assert.ok(/· 2 stories/.test(r.sent), 'group header carries its story count');
assert.ok(r.sent.includes('Print / save as PDF'), 'print button on the export view');
assert.ok(!/[?&]t=/.test(r.sent), 'no token in any link');

// exec summary reflects the data: 4 items, 2 negative, needs-response headline
assert.ok(/<b>4<\/b> brand-relevant/.test(r.sent), 'exec: item count');
assert.ok(/<b>2<\/b> ran negative/.test(r.sent), 'exec: negative count');
assert.ok(/needs-response bar/.test(r.sent) && /Vodafone Cash outage/.test(r.sent), 'exec: top negative surfaced');

// ── Word export: msword envelope + attachment filename ──
r = await call({ from: '2026-07-01', to: '2026-07-07', format: 'doc' }, asViewer);
assert.strictEqual(r.code, 200);
assert.ok(/application\/msword/.test(r.hdrs['content-type']), 'msword content-type');
assert.ok(r.hdrs['content-disposition'].includes('pr-radar-report-2026-07-01-to-2026-07-07.doc'), 'dated filename');
assert.ok(r.sent.includes('xmlns:w="urn:schemas-microsoft-com:office:word"'), 'Word namespace');
assert.ok(r.sent.includes('<w:WordDocument><w:View>Print</w:View>'), 'mso print-view block');

// ── validation 400s with caller-safe messages ──
r = await call({ from: '2026-07-10', to: '2026-07-01' }, asViewer);
assert.strictEqual(r.code, 400); assert.ok(/before/.test(r.body.error));
r = await call({ from: 'yesterday', to: '2026-07-01' }, asViewer);
assert.strictEqual(r.code, 400); assert.ok(/must be YYYY-MM-DD/.test(r.body.error));
r = await call({ from: '2026-01-01', to: '2026-07-01' }, asViewer);
assert.strictEqual(r.code, 400); assert.ok(/92 days/.test(r.body.error));

// ── email gate: send is ADMIN-only; viewer token → 403, no email attempted ──
r = await call({ from: '2026-07-01', to: '2026-07-07', send: '1' }, asViewer);
assert.strictEqual(r.code, 403);
assert.ok(/admin-only/.test(r.body.error));
// cron (admin) without REPORT_EMAIL_ENABLED → 200, skipped with a note
r = await call({ period: 'week', send: '1' }, { authorization: 'Bearer cron' });
assert.strictEqual(r.code, 200);
assert.strictEqual(r.body.sent, false);
assert.ok(/REPORT_EMAIL_ENABLED/.test(r.body.note));

// ── plain weekly view keeps its lean shape (no appendix, no exec regression) ──
r = await call({ period: 'week' }, asViewer);
assert.strictEqual(r.code, 200);
assert.ok(r.sent.includes('Weekly report'), 'weekly title intact');
assert.ok(!r.sent.includes('Appendix — coverage log'), 'weekly view has NO appendix');
assert.ok(!r.sent.includes('Print / save as PDF'), 'weekly view has NO print button (email-safe)');

console.log('REPORT-RANGE OK — viewer auth, exec summary + appendix + methodology, Word envelope + filename, 400 validation, admin-only send, lean weekly view');
