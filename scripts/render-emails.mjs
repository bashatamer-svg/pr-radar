#!/usr/bin/env node
// Render all four emails from live code, to eyeball or to diff against a design
// target. Run from the repo root:
//
//   node scripts/render-emails.mjs [outDir]        # default: .render-emails/
//
// The clock is PINNED (see NOW) so two runs are byte-identical and a diff shows
// only what the renderer changed — ages, the Cairo timestamp and the date line
// are all derived from it. The five stories are the real production rows the
// 2026-08 redesign was drawn from, kept here so the output stays comparable.
//
// This writes files and prints nothing else. It sends no email, reads no
// database, and needs no credentials.

import { writeFileSync, mkdirSync } from 'node:fs';

// 00:17 Cairo on 08 Aug 2026 (Africa/Cairo is UTC+3 in August).
const NOW = new Date('2026-08-07T21:17:00Z').getTime();
const RealDate = Date;
// Only the no-argument forms are pinned; `new Date(x)` must still parse x, or
// every published_at below would collapse to the same instant.
class PinnedDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
globalThis.Date = PinnedDate;

const hoursAgo = (h) => new RealDate(NOW - h * 36e5).toISOString();

process.env.BOARD_URL = process.env.BOARD_URL || 'https://pr-radar.approvalavengers.com/';

const { renderBulletin, renderUrgent } = await import('../lib/email.js');

const STORIES = [
  {
    id: 1990, brand: 'Vodafone', sentiment: 'negative', importance: 4,
    source: 'تليجراف مصر', author: 'إيناس عبر صفحتها', published_at: hoursAgo(25),
    headline: 'أول تحرك برلماني لمواجهة تسجيل خطوط المحمول بأسماء مواطنين دون علمهم',
    summary: "Parliament begins its first legislative move to address the practice of mobile operators registering phone lines in citizens' names without consent.",
    pr_angle: 'Read · Parliamentary action on unauthorized line registration signals regulatory and public backlash against the practice, creating a sector-wide reputational risk and potential legislative pressure on Vodafone and all operators.\nAudience · Regulators (NTRA, MCIT), legislators, consumers, data-privacy advocates.\nAction · Brief the legal and regulatory teams on parliamentary developments; prepare messaging on Vodafone\'s SIM registration safeguards; monitor for operator-specific allegations.',
  },
  {
    id: 1922, brand: 'Vodafone', sentiment: 'negative', importance: 4,
    source: 'Masrawy', author: null, published_at: hoursAgo(48),
    headline: 'إيناس عز الدين تكتشف تسجيل 5 خطوط باسمها وزوجها دون علمهما.. وتحذر: استعلموا أنتوا كمان',
    summary: "Public figure Inas Ezzeddin discovers five phone lines registered in her and her husband's names without their consent and warns others to check their accounts.",
    pr_angle: 'Read · Vodafone faces a data-privacy and unauthorized account-registration accusation from a public figure with viral reach; the case compounds consent and KYC-process concerns.\nAudience · Subscribers and general public; regulators (NTRA); raises questions about account-opening controls and customer protection.\nAction · Brief the team and monitor for NTRA involvement, regulatory correspondence, or legal developments; prepare holding lines on account verification and consent protocols.',
  },
  {
    id: 2027, brand: 'Vodafone', sentiment: 'negative', importance: 3,
    source: 'جريدة المال', author: null, published_at: hoursAgo(0.2),
    headline: 'مصادر: 48 إلى 72 ساعة لحذف الخط من «أرقامي» بعد إنكار ملكيته لدى شركة المحمول',
    summary: "Sources report that a phone line registered without the subscriber's consent can be deleted from their account within 48–72 hours after denying ownership to the mobile operator.",
    pr_angle: 'Read · The Inas Ezzeddin case continues to receive coverage; this report on deletion procedures signals the dispute remains active and under public scrutiny.\nAudience · Vodafone subscribers concerned about SIM-swap and unauthorised registration; regulators tracking the complaint.\nAction · Brief the team and monitor for any new filings, NTRA involvement, or statements from Ezzeddin\'s legal team.',
  },
  {
    id: 868, brand: 'Vodafone', sentiment: 'positive', importance: 4,
    source: 'جريدة حابي', author: null, published_at: hoursAgo(240),
    headline: 'فودافون مصر راعيًا رئيسيًا للأهلي وحقوق تسمية الاستاد مقابل 1.35 مليار جنيه',
    summary: 'Vodafone Egypt signs a multi-year title sponsorship of Al-Ahly Football Club and stadium naming rights for 1.35 billion Egyptian pounds, positioning itself as a major player in sports sponsorship.',
    pr_angle: "Read · Vodafone Egypt claims the top-tier Egyptian sports sponsorship, linking the brand to one of Africa's most-watched clubs and gaining pervasive brand visibility across matches, media and fan engagement.\nAudience · Consumers and sports fans; reinforces brand presence and association with cultural pride.\nAction · Coordinate with marketing on launch messaging and fan touchpoints; monitor social sentiment around the announcement.",
  },
  {
    id: 2026, brand: 'market', sentiment: 'negative', importance: 3,
    source: 'موقع الحرية الإخباري', author: null, published_at: hoursAgo(7),
    headline: 'بعد الجدل حول تطبيق "أرقامي".. مواطنون يستغيثون: "فوجئنا بخطوط مسجلة بأسمائنا يستخدمها سودانيون"',
    summary: 'Citizens report finding mobile lines registered in their names without consent, allegedly being used by Sudanese nationals, in what appears to be a widespread fraud pattern.',
    pr_angle: 'Read · Sector-wide KYC and fraud-control failure is escalating — lines are being registered in Egyptians’ names and trafficked to foreign nationals, signalling a serious breach of identity verification across operators including Vodafone.\nAudience · Subscribers and regulators (NTRA); public trust in operator security.\nAction · Monitor for operator-specific complaints and regulator response; prepare to address Vodafone\'s position if named; brief the team on regulatory risk.',
  },
];

const out = process.argv[2] || '.render-emails';
mkdirSync(out, { recursive: true });

const files = {
  // Team copy: greeting name, the private notice, the unclassified count and a
  // silent feed named in the footer.
  '1-daily-brief.html': renderBulletin({
    items: STORIES, broken: [{ feed_id: 'Youm7 (SectionRss)' }], scanned: 61,
    variant: 'admin', greetingName: 'Tamer', unclassified: 2,
  }),
  // Subscriber copy: same stories, same renderer, no name, all feeds live.
  '2-daily-brief-subscriber.html': renderBulletin({
    items: STORIES, broken: [], scanned: 61,
  }),
  '3-alert-impact4.html': renderUrgent(STORIES[0], process.env.BOARD_URL),
  '4-alert-impact5-urgent.html': renderUrgent({ ...STORIES[0], importance: 5 }, process.env.BOARD_URL),
};

for (const [name, html] of Object.entries(files)) {
  writeFileSync(`${out}/${name}`, html);
  console.log(`${out}/${name}  ${(Buffer.byteLength(html) / 1024).toFixed(1)}KB`);
}
