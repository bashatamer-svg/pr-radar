// sendBulletin must FAIL LOUDLY when it has no recipients. RADAR_TO silently
// disappearing from the Vercel env turned the daily brief into a six-day
// no-op — 200 OK, zero errors, zero emails. Never again: empty recipients now
// throws (callers catch + log), and an explicit `to` still works without env.
import assert from 'node:assert';

delete process.env.RADAR_TO;
process.env.RADAR_FROM = 'PR Radar <pr.radar@example.com>';
process.env.RESEND_API_KEY = 'k';

let posted = 0;
globalThis.fetch = async () => { posted++; return { ok: true, json: async () => ({ id: 'e' }) }; };

const { sendBulletin } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');

// no RADAR_TO + no explicit to → throws, and Resend is never called
await assert.rejects(() => sendBulletin('<p>x</p>', 'subject'), /no recipients.*RADAR_TO/);
assert.strictEqual(posted, 0, 'must not call Resend with an empty recipient list');

// explicit `to` still sends fine without RADAR_TO
await sendBulletin('<p>x</p>', 'subject', 'someone@vodafone.com');
assert.strictEqual(posted, 1, 'explicit to sends');

// RADAR_TO set → default send works again
process.env.RADAR_TO = 'Tamer <t@vodafone.com>, second@vodafone.com';
await sendBulletin('<p>x</p>', 'subject');
assert.strictEqual(posted, 2, 'RADAR_TO default send works');

console.log('SEND-GUARD OK — empty recipients throws loudly (no silent no-op); explicit to and RADAR_TO paths still send');
