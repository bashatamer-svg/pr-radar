// A severity-5 story must reach somebody.
//
// The urgent path called sendBulletin(html, subject) with no `to`, which falls
// back to RADAR_TO — unset in production. So every alert threw "no recipients",
// was caught, logged, and reached nobody. It went unnoticed because no story
// has ever been scored 5 (pr_items, checked 1 Aug: zero rows), so the first
// real crisis would have been the first test of a dead channel.
//
// Now: RADAR_TO when set, otherwise every active subscriber. Category filters
// are ignored on purpose — severity 5 is a live threat to Vodafone Egypt, so a
// surprise email beats a missed crisis.
import assert from 'node:assert';

process.env.RADAR_TOKEN = 'tok';
process.env.CRON_SECRET = 'admin';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.RESEND_API_KEY = 're_x';
process.env.RADAR_FROM = 'radar@example.com';

// A subscriber whose digest is narrowed to one category still gets the alert.
const SUBSCRIBERS = [
  { email: 'wide@example.com', name: null, categories: null },
  { email: 'narrow@example.com', name: null, categories: ['vodafone_cash'] },
];

const CRISIS_TITLE = 'Vodafone Egypt hit by nationwide outage, regulator opens inquiry';
const CRISIS_URL = 'https://news.google.com/rss/articles/crisis-1';

const rss = () => `<?xml version="1.0"?><rss><channel><item>
  <title>${CRISIS_TITLE}</title><link>${CRISIS_URL}</link>
  <source url="https://telegraph.eg">Telegraph Egypt</source>
  <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

// The classifier scores it 5 — the only thing that opens the urgent path.
const VERDICT = [{
  i: 0, is_relevant: true, brand: 'Vodafone', sentiment: 'negative', category: 'network',
  summary: 'A nationwide Vodafone Egypt outage drew a regulator inquiry.',
  pr_angle: '', importance: 5, confidence: 0.95,
}];

function harness() {
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = (opts.method || 'GET').toUpperCase();
    const ok = (t) => ({ ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t || 'null') });

    if (u.includes('news.google.com') || u.includes('/rss') || u.includes('/feed')) return ok(rss());
    if (u.includes('/rest/v1/pr_subscribers')) return ok(JSON.stringify(SUBSCRIBERS));
    if (u.includes('/rest/v1/pr_items') && m === 'POST') {
      return ok(JSON.stringify(JSON.parse(opts.body).map((r, i) => ({ ...r, id: 500 + i }))));
    }
    if (u.includes('api.anthropic.com')) return ok(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(VERDICT) }] }));
    if (u.includes('api.resend.com') && m === 'POST') { sent.push(JSON.parse(opts.body)); return ok('{"id":"x"}'); }
    if (u.includes('/rest/v1/')) return ok('[]');
    throw new Error('unexpected fetch ' + u);
  };
  return sent;
}

const load = async () => (await import(`${new URL('..', import.meta.url).pathname}/api/radar.js?t=${Math.random()}`)).default;
const run = async (handler) => {
  let code, body;
  const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; return res; }, setHeader() {}, end() {} };
  // The 15-min poll is where a crisis lands first — exercise that path.
  await handler({ query: { urgentOnly: '1' }, headers: { authorization: 'Bearer admin' } }, res);
  return { code, body };
};
const urgentOf = (sent) => sent.filter((m) => /^URGENT —/.test(m.subject || ''));

// ── RADAR_TO unset: the subscribers are the fallback ──
{
  delete process.env.RADAR_TO;
  const sent = harness();
  const { code, body } = await run(await load());
  assert.strictEqual(code, 200, 'run returns 200');
  assert.strictEqual(body.urgent, 1, `the story was scored 5 and opened the urgent path (body=${JSON.stringify(body)})`);

  const alerts = urgentOf(sent);
  // ONE MESSAGE PER RECIPIENT — an alert addressed to the whole list shows each
  // reader everyone else's address, and lets one bad entry make Resend reject
  // the batch, silencing a crisis alert for the entire team.
  assert.strictEqual(alerts.length, SUBSCRIBERS.length,
    `one alert per subscriber (got ${alerts.length} for ${SUBSCRIBERS.length})`);
  for (const a of alerts) {
    assert.strictEqual([].concat(a.to || []).length, 1,
      `each alert carries exactly one address (got ${JSON.stringify(a.to)})`);
  }
  const to = alerts.flatMap((a) => [].concat(a.to || []));
  for (const s of SUBSCRIBERS) {
    assert.ok(to.includes(s.email), `the alert reached ${s.email} (got ${JSON.stringify(to)})`);
  }
  // The narrow subscriber's category filter must NOT suppress a crisis.
  assert.ok(to.includes('narrow@example.com'),
    'a category-filtered subscriber still gets a severity-5 alert — filters are for the digest, not for crises');
}

// ── RADAR_TO set: it wins, so a curated crisis list stays possible ──
{
  process.env.RADAR_TO = 'crisis@example.com';
  const sent = harness();
  await run(await load());
  const alerts = urgentOf(sent);
  assert.strictEqual(alerts.length, 1, 'one urgent alert went out');
  const to = [].concat(alerts[0].to || []).map((a) => String(a));
  assert.ok(to.some((a) => a.includes('crisis@example.com')), `RADAR_TO is used when set (got ${JSON.stringify(to)})`);
  assert.ok(!to.some((a) => a.includes('@example.com') && /wide|narrow/.test(a)),
    `subscribers are not added on top of an explicit RADAR_TO (got ${JSON.stringify(to)})`);
  delete process.env.RADAR_TO;
}

// ── WHICH stories trip the instant alert, and how loudly ──
// Impact 4-5, or ANY negative Vodafone story whatever its Impact — a bad story
// about us shouldn't wait for the 05:00 brief just because its pickup is small.
// A negative story about a RIVAL is their problem: it alerts only if it also
// scores 4+. Sentiment is the story's own tone for the brand it names, so
// without the brand check every rival outage would page the team.
{
  const { isInstantAlert, urgentTier } = await import(`${new URL('..', import.meta.url).pathname}/lib/email.js`);
  const cases = [
    // [item, alerts?, tier label, why]
    [{ importance: 5, brand: 'Vodafone', sentiment: 'negative' }, true, 'URGENT', 'a crisis'],
    [{ importance: 5, brand: 'Orange', sentiment: 'neutral' }, true, 'URGENT', 'Impact 5 alone is enough'],
    [{ importance: 4, brand: 'Orange', sentiment: 'positive' }, true, 'ALERT', 'a major competitor win'],
    [{ importance: 3, brand: 'Vodafone', sentiment: 'negative' }, true, 'ALERT', 'negative about us, modest pickup'],
    [{ importance: 2, brand: 'Vodafone', sentiment: 'negative' }, true, 'ALERT', 'negative about us, small pickup'],
    [{ importance: 3, brand: 'Vodafone', sentiment: 'positive' }, false, null, 'good news waits for the brief'],
    [{ importance: 3, brand: 'Vodafone', sentiment: 'neutral' }, false, null, 'neutral waits for the brief'],
    [{ importance: 3, brand: 'Orange', sentiment: 'negative' }, false, null, "a rival's problem is not our alert"],
    [{ importance: 2, brand: 'e&', sentiment: 'negative' }, false, null, 'nor a small one'],
  ];
  for (const [item, want, label, why] of cases) {
    assert.strictEqual(isInstantAlert(item), want,
      `${why}: ${JSON.stringify(item)} should ${want ? '' : 'NOT '}alert`);
    if (want) {
      assert.strictEqual(urgentTier(item).label, label,
        `${why}: labelled ${label} (got ${urgentTier(item).label})`);
    }
  }
  // Only a real crisis says URGENT. Labelling every alert URGENT is how the
  // channel gets ignored, which costs more than the alert saves.
  assert.strictEqual(urgentTier({ importance: 4 }).label, 'ALERT', 'Impact 4 is not shouted as URGENT');
  assert.strictEqual(urgentTier({ importance: 5 }).label, 'URGENT', 'Impact 5 is');
}

// ── the alert body must match its tier, not hardcode "severity-5" ──
{
  const { renderUrgent } = await import(`${new URL('..', import.meta.url).pathname}/lib/email.js`);
  const soft = renderUrgent({ id: 1, importance: 2, brand: 'Vodafone', sentiment: 'negative', headline: 'x', summary: 's' }, '');
  assert.ok(/● ALERT/.test(soft), 'a low-Impact Vodafone negative is badged ALERT');
  assert.ok(!/severity-5/.test(soft), 'and is never described as a severity-5 threat');
  assert.ok(/a negative Vodafone story/.test(soft), 'the body says why it fired');
  const hard = renderUrgent({ id: 2, importance: 5, brand: 'Vodafone', sentiment: 'negative', headline: 'y', summary: 's' }, '');
  assert.ok(/● URGENT/.test(hard) && /severity-5 reputational threat/.test(hard), 'a real crisis still reads URGENT');
}

console.log('URGENT-RECIPIENTS OK — Impact 4-5 and any negative Vodafone story alert instantly (rivals only at 4+), tiered URGENT vs ALERT in both subject and body, to every active subscriber when RADAR_TO is unset (category filters ignored) and to RADAR_TO alone when set');
