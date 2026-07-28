// Task 4 — no RADAR_TOKEN in ANY generated link (emails + webhooks). Renders
// every builder with a distinctive token in env and asserts the token string
// never appears, while board links + deep-link anchors survive.
import assert from 'node:assert';

const TOKEN = 'SEKRIT-TOKEN-123';
process.env.RADAR_TOKEN = TOKEN;
process.env.BOARD_URL = 'https://pr-radar.example.com/';
process.env.URGENT_WEBHOOK_URL = 'https://hooks.example/x';

const { renderBulletin, renderUrgent } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');
const { renderSurgeEmail } = await import(new URL('..', import.meta.url).pathname + '/lib/surge.js');
const { renderReport } = await import(new URL('..', import.meta.url).pathname + '/lib/report.js');
const { postUrgentWebhook, postSurgeWebhook } = await import(new URL('..', import.meta.url).pathname + '/lib/notify.js');

const noToken = (s, where) => {
  assert.ok(!s.includes(TOKEN), `${where}: token string leaked`);
  assert.ok(!/[?&]t=/.test(s), `${where}: a ?t=/&t= param is present`);
  assert.ok(!/t=SEKRIT/.test(s), `${where}: token appears as t=<value>`);
};

const item = { id: 42, hash: 'h', headline: 'Vodafone Cash nationwide outage', url: 'https://news/x', resolved_url: 'https://news/x', source: 'Youm7', brand: 'Vodafone', sentiment: 'negative', importance: 5, category: 'vodafone_cash', published_at: new Date().toISOString(), instances: [{ outlet: 'Youm7' }] };

// 1. Daily bulletin (renderBulletin) — board button + item cards
const bulletin = renderBulletin({ items: [item], broken: [], scanned: 120, greetingName: 'Team', unclassified: 0 });
noToken(bulletin, 'renderBulletin');
assert.ok(bulletin.includes('pr-radar.example.com'), 'bulletin still links to the board');
assert.ok(bulletin.includes('#item-42'), 'bulletin item card still deep-links (#item-42)');
assert.ok(!/carry your personal access token/.test(bulletin), 'stale "carry your personal access token" note removed');

// 2. Urgent single-item alert (renderUrgent)
const urgent = renderUrgent(item, process.env.BOARD_URL);
noToken(urgent, 'renderUrgent');
assert.ok(urgent.includes('pr-radar.example.com'), 'urgent still links to the board');
assert.ok(urgent.includes('#item-42') || urgent.includes('/api/go?id=42'), 'urgent still deep-links to the item');

// 3. Surge email (renderSurgeEmail)
const surge = { brand: 'Vodafone', multiple: 3, today: 12, windowDays: 14, mean: 4, stddev: 1.5, threshold: 8, topStories: [{ id: 42, headline: 'Vodafone Cash outage', outlets: 5 }] };
const surgeHtml = renderSurgeEmail([surge], process.env.BOARD_URL);
noToken(surgeHtml, 'renderSurgeEmail');
assert.ok(surgeHtml.includes('/api/go?id=42'), 'surge story still uses the /api/go share redirect');
assert.ok(surgeHtml.includes('pr-radar.example.com'), 'surge still links to the board');

// 4. Weekly/monthly report (renderReport)
const reportData = {
  totals: { items: 10, negatives: 3, positives: 2, vodShare: 40, vodSharePrev: 38, prevItems: 8, prevNegatives: 2, prevPositives: 1 },
  sov: [], categories: [], topNeg: [], wins: [], days: 7, generatedAt: new Date().toISOString(),
};
const report = renderReport(reportData, { period: 'week' });
noToken(report, 'renderReport');
assert.ok(report.includes('pr-radar.example.com'), 'report still links to the board');

// 5 & 6. Webhooks (notify.js) — capture the POSTed body, assert token-free
let bodies = [];
globalThis.fetch = async (url, opts) => { bodies.push(String(opts && opts.body || '')); return { ok: true, status: 200, text: async () => '' }; };
await postUrgentWebhook(item, process.env.BOARD_URL);
await postSurgeWebhook(surge, process.env.BOARD_URL);
assert.strictEqual(bodies.length, 2, 'both webhooks posted');
noToken(bodies[0], 'postUrgentWebhook body');
noToken(bodies[1], 'postSurgeWebhook body');
assert.ok(bodies[0].includes('pr-radar.example.com'), 'urgent webhook still carries the board link');
assert.ok(bodies[0].includes('#item-42'), 'urgent webhook still deep-links the item');

console.log('NO-TOKEN OK — bulletin/urgent/surge/report emails + both webhooks carry the board link with NO ?t= token; deep-link anchors (#item / /api/go) preserved');
