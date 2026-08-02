// Deliverability counts PR RADAR'S sends, not the shared account's.
//
// The Resend account also carries another app's daily bulletin (~18 sends a
// day), so the unfiltered count answered "is the ACCOUNT delivering" — 22 rows
// on 2 Aug of which only 4 were PR Radar's. Worse than cosmetic: the other
// app's bounce would redden THIS app's health page, and a PR Radar bounce could
// hide inside a green account-wide majority. Each app mails from its own
// address, so the summary filters on RADAR_FROM.
import assert from 'node:assert';

process.env.RESEND_API_KEY = 're_x';

const now = Date.now();
const iso = (agoH) => new Date(now - agoH * 36e5).toISOString();
const ROWS = [
  // ours — one delivered, one bounced, one too old to count
  { from: 'PR Radar <PR.Radar@approvalavengers.com>', last_event: 'delivered', created_at: iso(2) },
  { from: 'PR.Radar@approvalavengers.com', last_event: 'bounced', created_at: iso(5) },
  { from: 'PR.Radar@approvalavengers.com', last_event: 'delivered', created_at: iso(30) },
  // the other app — delivered AND failed, neither may count when scoped
  { from: 'Regulatory Radar <Regulatory.Radar@approvalavengers.com>', last_event: 'delivered', created_at: iso(1) },
  { from: 'Regulatory Radar <Regulatory.Radar@approvalavengers.com>', last_event: 'failed', created_at: iso(1) },
];

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: ROWS }) });
const load = async () => (await import(`${new URL('..', import.meta.url).pathname}/lib/deliverability.js?t=${Math.random()}`));

// ── RADAR_FROM set (as in production): only our two in-window rows count ──
{
  process.env.RADAR_FROM = 'PR Radar <PR.Radar@approvalavengers.com>';
  const { recentDeliveryStatus } = await load();
  const r = await recentDeliveryStatus({ hours: 26 });
  assert.strictEqual(r.scope, 'pr-radar', `scoped when RADAR_FROM is set (got ${r.scope})`);
  assert.strictEqual(r.total, 2, `our 2 in-window sends, not the account's 4 (got ${r.total})`);
  // The failure that must move the needle is OURS…
  assert.strictEqual(r.bad, 1, `our bounce is counted (got ${r.bad})`);
  // …and the other app's 'failed' must NOT be in the tallies at all.
  assert.strictEqual(r.byStatus.failed, undefined, `the other app's failure does not redden our page (byStatus ${JSON.stringify(r.byStatus)})`);
}

// ── RADAR_FROM unset: nothing to filter by, the account-wide count stands ──
{
  delete process.env.RADAR_FROM;
  const { recentDeliveryStatus } = await load();
  const r = await recentDeliveryStatus({ hours: 26 });
  assert.strictEqual(r.scope, 'account', `unscoped without RADAR_FROM (got ${r.scope})`);
  assert.strictEqual(r.total, 4, `all in-window rows count (got ${r.total})`);
  assert.strictEqual(r.bad, 2, `both failures count account-wide (got ${r.bad})`);
}

console.log('DELIVERABILITY-SCOPE OK — with RADAR_FROM set the summary counts only PR Radar mail (our bounce counts, the other app\'s failure is excluded); without it the account-wide count stands and is labelled as such');
