// sendBulletin must FAIL LOUDLY when it has no recipients. RADAR_TO silently
// disappearing from the Vercel env turned the daily brief into a six-day
// no-op — 200 OK, zero errors, zero emails. Never again: empty recipients now
// throws (callers catch + log), and an explicit `to` still works without env.
import assert from 'node:assert';

delete process.env.RADAR_TO;
process.env.RADAR_FROM = 'PR Radar <pr.radar@example.com>';
process.env.RESEND_API_KEY = 'k';

let posted = 0;
const bodies = [];
globalThis.fetch = async (_u, o = {}) => {
  posted++;
  if (o.body) bodies.push(JSON.parse(o.body));
  return { ok: true, json: async () => ({ id: 'e' }) };
};

const { sendBulletin } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');

// no RADAR_TO + no explicit to → throws, and Resend is never called
await assert.rejects(() => sendBulletin('<p>x</p>', 'subject'), /no recipients.*RADAR_TO/);
assert.strictEqual(posted, 0, 'must not call Resend with an empty recipient list');

// explicit `to` still sends fine without RADAR_TO
await sendBulletin('<p>x</p>', 'subject', 'someone@vodafone.com');
assert.strictEqual(posted, 1, 'explicit to sends');

// RADAR_TO set → default send works again, ONE MESSAGE PER RECIPIENT.
// A single call addressed to the whole list shows every reader the others'
// addresses — on a corporate list that is a disclosure, not a formatting
// detail — and lets one bad address make Resend reject the batch for everybody.
process.env.RADAR_TO = 'Tamer <t@vodafone.com>, second@vodafone.com';
bodies.length = 0;
const res = await sendBulletin('<p>x</p>', 'subject');
assert.strictEqual(posted, 3, 'two RADAR_TO recipients cost two sends, not one batched call');
assert.strictEqual(bodies.length, 2, 'one request per recipient');
for (const b of bodies) {
  assert.strictEqual(b.to.length, 1, `each message carries exactly one address (got ${JSON.stringify(b.to)})`);
}
assert.deepStrictEqual(bodies.flatMap((b) => b.to).sort(), ['Tamer <t@vodafone.com>', 'second@vodafone.com'],
  'and between them they cover the whole list');
assert.strictEqual(res.sent, 2, 'the caller is told how many landed');
assert.ok(res.id, 'and can still read an id, as before');

// A partial failure must not throw — the copies that landed did land — but a
// TOTAL failure still throws, because that is the dead-channel signal callers
// log and scream on.
{
  let n = 0;
  globalThis.fetch = async () => (++n === 1
    ? { ok: false, status: 422, text: async () => 'bad address' }
    : { ok: true, json: async () => ({ id: 'e2' }) });
  const partial = await sendBulletin('<p>x</p>', 'subject');
  assert.strictEqual(partial.sent, 1, 'the good recipient still got it');
  assert.strictEqual(partial.failed, 1, 'and the bad one is reported, not hidden');

  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'down' });
  await assert.rejects(() => sendBulletin('<p>x</p>', 'subject'), /all 2 recipient/,
    'reaching nobody still throws loudly');
}

console.log('SEND-GUARD OK — empty recipients throws loudly (no silent no-op); every send is one message per recipient (no shared To); a partial failure is reported while reaching nobody still throws');
