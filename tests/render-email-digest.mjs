// The 2026-08 "morning digest" email redesign. Pins the four things it exists
// to do — promote the action, make Impact legible, lift one hero story, keep
// the counts honest — plus the bidi rule that Arabic headlines depend on.
//
// Unit-only: renderBulletin/renderUrgent are pure over their arguments, so this
// needs no browser and no database.
import assert from 'node:assert';

process.env.BOARD_URL = 'https://pr.example/';
const { renderBulletin, renderUrgent, pickHero } = await import(new URL('..', import.meta.url).pathname + '/lib/email.js');

const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
const ANGLE = 'Read · why it matters\nAudience · who cares\nAction · do this thing';
const mk = (o) => ({
  summary: 'A summary.', source: 'Masrawy', pr_angle: ANGLE,
  published_at: ago(3), seen_at: ago(3), ...o,
});

// ── hero selection ───────────────────────────────────────────────────────────
{
  const older = mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 4, headline: 'older four', published_at: ago(48) });
  const newer = mk({ id: 2, brand: 'Vodafone', sentiment: 'negative', importance: 4, headline: 'newer four', published_at: ago(2) });
  const small = mk({ id: 3, brand: 'Vodafone', sentiment: 'negative', importance: 2, headline: 'small', published_at: ago(1) });
  assert.strictEqual(pickHero([older, small, newer]).id, 2, 'highest Impact wins, ties broken by recency');

  // A win, a rival and a market story are NOT candidates: the hero answers
  // "what must we respond to", and that lane is Vodafone-negative only.
  const win = mk({ id: 4, brand: 'Vodafone', sentiment: 'positive', importance: 5, headline: 'win' });
  const rival = mk({ id: 5, brand: 'Orange', sentiment: 'negative', importance: 5, headline: 'rival' });
  const market = mk({ id: 6, brand: 'market', sentiment: 'negative', importance: 5, headline: 'market' });
  assert.strictEqual(pickHero([win, rival, market]), null, 'no needs-a-response story ⇒ no hero');
  const quiet = renderBulletin({ items: [win, rival, market], broken: [], scanned: 9 });
  assert.ok(!/Read this first/.test(quiet), 'and no hero panel is rendered');
  assert.ok(/Wins to amplify[\s\S]*?·&nbsp; 1 item/.test(quiet), 'lanes then use their plain counts');
}

// ── the counts must reconcile with the total the intro states ────────────────
// The hero is printed above its lane, so that lane's heading has to exclude it
// without appearing to lose a story. Getting this wrong sends a reader hunting
// for a card that is already on screen.
{
  const items = [
    mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 5, headline: 'hero' }),
    mk({ id: 2, brand: 'Vodafone', sentiment: 'negative', importance: 3, headline: 'second' }),
    mk({ id: 3, brand: 'Vodafone', sentiment: 'negative', importance: 2, headline: 'third' }),
    mk({ id: 4, brand: 'Vodafone', sentiment: 'positive', importance: 3, headline: 'win' }),
  ];
  const html = renderBulletin({ items, broken: [], scanned: 40 });
  assert.ok(/>4 items<\/strong> on the radar today/.test(html), 'the intro states the true total');
  assert.ok(/Needs a response[\s\S]*?·&nbsp; 2 more, after the one above/.test(html),
    'the hero lane counts only what is left below it');
  assert.ok(/Wins to amplify[\s\S]*?·&nbsp; 1 item/.test(html), 'other lanes are unaffected');
  // 1 hero + 2 + 1 = the 4 the intro promised.
  assert.strictEqual((html.match(/Open on board →/g) || []).length, 3, 'three standard cards');
  assert.strictEqual((html.match(/Read this first/g) || []).length, 1, 'plus exactly one hero');

  // A lane the hero EMPTIES still gets its heading: the lane names are shared
  // with the board and the guide, and on a day with a single story to respond
  // to the words "Needs a response" would otherwise never appear.
  const lone = renderBulletin({ items: [items[0], items[3]], broken: [], scanned: 9 });
  assert.ok(/Needs a response[\s\S]*?·&nbsp; just the one above/.test(lone),
    'the hero-only lane keeps its name and says so');
}

// ── Impact: five dashes AND the word ─────────────────────────────────────────
{
  const html = renderBulletin({
    items: [mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 4, headline: 'h' })],
    broken: [], scanned: 1,
  });
  const dashes = html.match(/width:16px;height:7px[^"]*background:(#[0-9a-f]{6})/g) || [];
  assert.strictEqual(dashes.length, 5, 'always five dashes, filled and empty');
  assert.strictEqual(dashes.filter((d) => d.includes('#f27100')).length, 4, 'four filled at Impact 4');
  assert.strictEqual(dashes.filter((d) => d.includes('#e7e9ee')).length, 1, 'one empty, in the board hairline');
  assert.ok(!/#d9cdca/.test(html), 'the retired warm empty-dot colour is gone');
  // Colour alone is not readable to a colour-blind reader, and orange-vs-red at
  // 7px is exactly the pair that goes. The number and the word carry it too.
  assert.ok(/Impact 4 · High/.test(html), 'the hero states the Impact in words');
}

// ── the action is promoted above the reasoning ───────────────────────────────
{
  const html = renderBulletin({
    items: [
      mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 5, headline: 'hero' }),
      mk({ id: 2, brand: 'Vodafone', sentiment: 'neutral', importance: 2, headline: 'card' }),
    ],
    broken: [], scanned: 2,
  });
  // Standard card: the action is the panel's headline value; Read is demoted to
  // "Why:" beneath a hairline.
  assert.ok(/Do this<\/div>\s*<div dir="auto"[^>]*font-weight:600;">do this thing</.test(html),
    'the card leads with the Action line');
  assert.ok(/<strong[^>]*>Why: <\/strong>why it matters/.test(html), 'Read is demoted and relabelled Why');
  assert.ok(/<strong[^>]*>Audience: <\/strong>who cares/.test(html), 'Audience is demoted too');
  // The hero keeps the classifier's own three labels under the shared heading.
  assert.ok(/What to do with this/.test(html), 'the hero keeps the shared vocabulary');

  // A fourth label must not be silently dropped — the parser is generic on
  // purpose, and a hard-coded Read/Audience/Action reader loses the day the
  // prompt grows a line.
  const four = renderBulletin({
    items: [mk({ id: 3, brand: 'Vodafone', sentiment: 'neutral', importance: 2, headline: 'x', pr_angle: ANGLE + '\nTiming · by Thursday' })],
    broken: [], scanned: 1,
  });
  assert.ok(/<strong[^>]*>Timing: <\/strong>by Thursday/.test(four), 'an unexpected angle label still renders');
}

// ── bidi: dir="auto" only on single-language runs ────────────────────────────
// dir="auto" takes the FIRST strong character and sets the direction of the
// whole node, so an Arabic outlet joined to a Latin age reorders and the
// separators land at the wrong end.
{
  const html = renderBulletin({
    items: [mk({
      id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 4,
      headline: 'أول تحرك برلماني لمواجهة تسجيل خطوط المحمول', source: 'تليجراف مصر', author: 'إيناس عبر صفحتها',
    })],
    broken: [], scanned: 1,
  });
  for (const m of html.matchAll(/<span dir="auto">([^<]*)<\/span>/g)) {
    assert.ok(!m[1].includes('·'),
      `a dir="auto" span must hold ONE language run, got: ${m[1]}`);
  }
  assert.ok(/<span dir="auto">تليجراف مصر<\/span> · /.test(html), 'the outlet is fenced, the separator is not');
  assert.ok(/<div dir="auto"[^>]*>\s*<a [^>]*>أول تحرك/.test(html), 'the headline itself still carries dir="auto"');
}

// ── team copy vs subscriber copy ─────────────────────────────────────────────
{
  const items = [mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 4, headline: 'h' })];
  const args = { items, broken: [{ feed_id: 'Youm7 (SectionRss)' }], scanned: 61, unclassified: 2 };
  const team = renderBulletin({ ...args, variant: 'admin', greetingName: 'Tamer' });
  const subs = renderBulletin({ ...args, greetingName: 'Sara' });

  assert.ok(/Good morning, Tamer\./.test(team) && /Good morning, Sara\./.test(subs), 'both copies greet by name');
  assert.ok(/Good morning\./.test(renderBulletin({ items, broken: [], scanned: 1 })), 'and fall back without one');

  assert.ok(/please don't forward/.test(team), 'the team copy is marked private');
  assert.ok(!/please don't forward/.test(subs), 'the subscriber copy is not');
  assert.ok(/Youm7 \(SectionRss\)/.test(team), 'the team copy names the silent feed');
  assert.ok(!/Youm7 \(SectionRss\)/.test(subs), 'a subscriber has no use for an internal feed id');

  // But BOTH must learn the sweep was narrow — this clause is the only place a
  // reader is told the radar was partially blind.
  for (const [who, html] of [['team', team], ['subscriber', subs]]) {
    assert.ok(/One feed is silent, so today's sweep is slightly narrower than usual\./.test(html),
      `${who}: told the sweep was narrow`);
  }
  assert.ok(/All feeds are live, so today's sweep is complete\./.test(renderBulletin({ items, broken: [], scanned: 1 })),
    'and told plainly when it was not');
  assert.ok(/2 feeds are silent/.test(renderBulletin({ ...args, broken: [{ feed_id: 'a' }, { feed_id: 'b' }], variant: 'admin' })),
    'the clause pluralises');
}

// ── Gmail clips a message past ~102KB, and clipping hides the footer ─────────
// Live volume is 1–15 relevant stories a day; 20 is well above the observed
// maximum. Measured 2026-08: the brief crosses the threshold at ~24 stories, so
// this fails as an early warning if the per-card markup grows.
{
  const many = Array.from({ length: 20 }, (_, i) => mk({
    id: i + 1, brand: 'Vodafone', sentiment: 'negative', importance: (i % 5) + 1,
    headline: 'مصادر: 48 إلى 72 ساعة لحذف الخط من «أرقامي» بعد إنكار ملكيته لدى شركة المحمول رقم ' + i,
    summary: 'Sources report that a phone line registered without the subscriber consent can be deleted from their account within 48-72 hours after denying ownership to the mobile operator, according to people familiar with the matter.',
  }));
  const bytes = Buffer.byteLength(renderBulletin({ items: many, broken: [], scanned: 300, variant: 'admin', greetingName: 'Tamer', unclassified: 3 }));
  assert.ok(bytes < 102400, `a 20-story brief must not be clipped by Gmail (${(bytes / 1024).toFixed(1)}KB)`);
}

// ── the alert keeps its two tiers visually distinct ──────────────────────────
{
  const item = mk({ id: 1, brand: 'Vodafone', sentiment: 'negative', importance: 5, headline: 'h' });
  const urgent = renderUrgent(item, 'https://pr.example/');
  const alert = renderUrgent({ ...item, importance: 4 }, 'https://pr.example/');
  assert.ok(/Why this needs comms now/.test(urgent), 'the alert names its angle block');
  // An Impact-4 WIN can alert too, and a red "why this needs comms now" over a
  // win reads as a crisis that is not one.
  const win = renderUrgent({ ...item, sentiment: 'positive', importance: 4 }, 'https://pr.example/');
  assert.ok(/background:#edfaf1/.test(win), 'a positive alert takes the win tint');
  assert.ok(/background:#fff2f0/.test(alert), 'a negative one stays red');
}

console.log('EMAIL-DIGEST OK — hero picked by Impact then recency (none when the lane is empty), lane counts reconcile with the stated total, Impact reads as five dashes AND a word, the action leads each card, dir="auto" fences single language runs, team/subscriber copies differ only where intended, and a 20-story brief stays under Gmail\'s clip threshold');
