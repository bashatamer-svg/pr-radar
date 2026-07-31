// Relevance prefilter: direct outlet firehoses must mention a brand or a
// mobile-market term before they cost a classifier call; query-scoped Google
// News feeds always pass. Without this, adding a national daily's feed would
// send hundreds of football/crime items a day to the classifier.
import assert from 'node:assert';
import { isWorthClassifying, ALL_FEEDS, FEEDS, DIRECT_FEEDS, SITE_FEEDS, BRAND_FEEDS } from '../lib/sources.js';
import { FEED_CANDIDATES } from '../lib/feed-candidates.js';

const direct = (headline, snippet = '') => isWorthClassifying({ headline, snippet, _direct: true });
const gnews = (headline) => isWorthClassifying({ headline, snippet: '', _direct: false });

// 1. Query-scoped feeds are never prefiltered — the query already scoped them.
assert.ok(gnews('الأهلي يفوز على الزمالك'), 'google-news items always pass');
assert.ok(gnews('anything at all'), 'google-news items always pass (EN)');

// 2. Direct-feed noise is dropped.
for (const noise of [
  'الأهلي يفوز على الزمالك في قمة الدوري',
  'ارتفاع درجات الحرارة غدا في القاهرة',
  'Egypt tourism revenues hit record high',
  'Gold prices rise in local market',
]) assert.ok(!direct(noise), `dropped as noise: ${noise}`);

// 3. Brand mentions pass, in both languages and common spellings.
for (const hit of [
  'فودافون مصر تطلق باقة جديدة',
  'ڤودافون كاش تضيف خدمة جديدة',
  'أورنج مصر توقع شراكة',
  'اورنج تعلن نتائجها',
  'المصرية للاتصالات تعلن نتائج الربع الثاني',
  'اتصالات مصر تطلق حملة',
  'Vodafone Egypt reports growth',
  'Telecom Egypt signs agreement',
]) assert.ok(direct(hit), `brand item kept: ${hit}`);

// 4. Sector stories with NO brand named must survive — the market sweep exists
//    precisely for these (a nationwide outage, a tariff row, an NTRA decision).
for (const sector of [
  'انقطاع الإنترنت الأرضي في عدة محافظات',
  'الجهاز القومي لتنظيم الاتصالات يصدر قرارا جديدا',
  'ارتفاع أسعار باقات المحمول',
  'Egypt mobile operator prices under review',
  'NTRA announces new spectrum auction',
  '5G rollout begins in Egypt',
]) assert.ok(direct(sector), `sector item kept: ${sector}`);

// 5. The snippet counts too — a headline can be vague while the body names the brand.
assert.ok(direct('شكوى من خدمة العملاء', 'أحد عملاء فودافون مصر يشكو من الخدمة'), 'snippet mention keeps the item');

// 6. Wiring: DIRECT_FEEDS are flagged in ALL_FEEDS, Google News feeds are not.
const byId = Object.fromEntries(ALL_FEEDS.map((f) => [f.id, f]));
for (const f of DIRECT_FEEDS) assert.strictEqual(byId[f.id].direct, true, `${f.id} flagged direct`);
for (const f of FEEDS) assert.ok(!byId[f.id].direct, `${f.id} is query-scoped, not direct`);

// 6b. Site-scoped sweeps are query-scoped like FEEDS — never prefiltered.
for (const f of SITE_FEEDS) assert.ok(!byId[f.id].direct, `${f.id} is query-scoped, not direct`);
// ...and they stay OUT of the 30-min urgent poll, which keeps to brand queries.
const pollIds = new Set(BRAND_FEEDS.map((f) => f.id));
for (const f of SITE_FEEDS) assert.ok(!pollIds.has(f.id), `${f.id} must not run on the urgent poll`);

// 6c. COVERAGE: every outlet the team asked for is reachable by some feed —
// either a site-scoped query or a direct feed. This is the guarantee that the
// requested source list is actually being watched.
const REQUESTED = [
  'almalnews.com', 'alborsaanews.com', 'amwalalghad.com', 'hapijournal.com', 'enterprise.press',
  'dailynewsegypt.com', 'businesstodayegypt.com', 'egypttoday.com', 'youm7.com', 'masrawy.com',
  'almasryalyoum.com', 'elwatannews.com', 'cairo24.com', 'elbalad.news', 'mobtada.com',
  'dostor.org', 'shorouknews.com', 'gate.ahram.org.eg', 'aitnews.com', 'arabhardware.net',
  'telecomreviewafrica.com', 'developingtelecoms.com', 'commsupdate.com', 'adigitalboom.com',
  'zawya.com', 'mubasher.info', 'reuters.com', 'asharqbusiness.com', 'alarabiya.net',
  'cnnbusinessarabic.com', 'arabfinance.com', 'tra.gov.eg', 'mcit.gov.eg', 'egx.com.eg',
  'cabinet.gov.eg', 'vodafone.com.eg', 'orange.eg', 'etisalat.eg', 'te.eg',
];
const allQueries = SITE_FEEDS.map((f) => decodeURIComponent(f.url)).join(' ');
const directHosts = DIRECT_FEEDS.map((f) => new URL(f.url).hostname.replace(/^www\.|^en\./, ''));
for (const d of REQUESTED) {
  const covered = allQueries.includes(`site:${d}`) || directHosts.some((h) => h.endsWith(d));
  assert.ok(covered, `requested outlet not covered by any feed: ${d}`);
}
// Every site: query must also carry a brand/sector constraint, or it would pull
// the outlet's entire output (the volume problem the prefilter exists to stop).
for (const f of SITE_FEEDS) {
  const q = decodeURIComponent(f.url);
  const scoped = /فودافون|Vodafone|اتصالات|المحمول|الإنترنت|تليكوم/.test(q) || f.id === 'site-newsrooms';
  assert.ok(scoped, `${f.id}: site query must be brand/sector scoped`);
}

// 7. Candidate list hygiene — it is a staging area, not a live source list.
const ids = FEED_CANDIDATES.map((c) => c.id);
assert.strictEqual(new Set(ids).size, ids.length, 'candidate ids are unique');
for (const c of FEED_CANDIDATES) {
  assert.ok(c.urls.length >= 1, `${c.id} has at least one candidate URL`);
  assert.ok(c.urls.every((u) => /^https:\/\//.test(u)), `${c.id} candidates are https`);
  assert.ok(['business', 'telecom', 'wire', 'general', 'newsroom', 'official'].includes(c.kind), `${c.id} has a known kind`);
}
const liveUrls = new Set(ALL_FEEDS.map((f) => f.url));
for (const c of FEED_CANDIDATES) {
  for (const u of c.urls) assert.ok(!liveUrls.has(u), `${c.id}: candidate ${u} must not already be live (verify, then move it)`);
}

console.log(`PREFILTER OK — ${REQUESTED.length} requested outlets all covered (${SITE_FEEDS.length} site sweeps + ${DIRECT_FEEDS.length} direct feeds); firehoses gated on brand/sector terms; site sweeps stay off the urgent poll; ${FEED_CANDIDATES.length} candidates staged, none pre-promoted`);
