// Source definitions for the PR Radar (brand & reputation monitor).
//
// SCOPE: Egypt only, and only the four mobile brands the PR team tracks:
//   Vodafone Egypt, Orange Egypt, WE (Telecom Egypt), e& Egypt (Etisalat Misr).
//
// Unlike the regulatory radar, this net is NOT about regulators — it is about
// what is being said about these brands, by whom, and where. The classifier
// judges sentiment and reputational risk, not regulatory materiality.
//
// Google News RSS is the broad net: free, no key, decent Arabic + English
// coverage, and it encodes the publishing outlet in the title as
// "Headline - Publisher" (radar.js already parses that into `source`). It is
// noisy on purpose — the classifier does the filtering, not the query.
//
// `brand` is carried through so the pipeline and board can group/filter by the
// brand a story is about. `tier` is kept for schema compatibility with the
// pipeline but is uniform (1 = Egypt) since scope is Egypt-only.

const gnews = (q, locale = 'en') => {
  const l = {
    en: 'hl=en-US&gl=US&ceid=US:en',
    ar: 'hl=ar&gl=EG&ceid=EG:ar',
  }[locale];
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&${l}`;
};

// ---------------------------------------------------------------------------
// Brand query sets. Each brand gets an English and an Arabic query so we catch
// both the English-language business press and the Arabic-language outlets that
// drive most local sentiment. Queries are pinned to Egypt to keep e& / Orange /
// Vodafone group-level global noise out.
// ---------------------------------------------------------------------------
export const FEEDS = [
  // ---- Vodafone Egypt (the home brand) ----
  // The bare Arabic "فودافون" was assumed Egypt-safe, but live data proved it is
  // not: it surfaces Vodafone QATAR ("فودافون قطر"), Vodafone OMAN and Vodafone
  // Group M&A far more than Vodafone EGYPT, so the classifier (correctly) drops
  // nearly all of it and the home brand reads near-zero. Like Orange, Vodafone is
  // a multi-market Arabic brand and needs an Egypt anchor. "فودافون كاش" (Vodafone
  // Cash) is the single richest Egypt-only surface — outages, fees, fraud — so it
  // is called out explicitly. The market sweep + Egyptian DIRECT_FEEDS catch the
  // rest; the classifier's NON-EGYPT rule drops any Gulf/Group that slips through.
  { id: 'vf-eg-en', tier: 1, brand: 'Vodafone', country: 'Egypt',
    url: gnews('"Vodafone Egypt" OR "Vodafone Cash"') },
  { id: 'vf-eg-ar', tier: 1, brand: 'Vodafone', country: 'Egypt',
    url: gnews('"فودافون مصر" OR "فودافون كاش" OR "فودافون إيجيبت"', 'ar') },

  // ---- Orange Egypt ----
  // Orange is a multi-market Arabic brand (big in Jordan, Morocco, Tunisia), so —
  // unlike "فودافون", which is effectively Egypt-only in Arabic — a bare "أورنج"
  // query floods in Orange JORDAN board/CSR news via regional wires (Petra / وكالة
  // الانباء الاردنية, مدار الساعة). Anchor the Arabic query to Egypt-specific forms;
  // the market sweep, the Egyptian DIRECT_FEEDS, and the classifier's non-Egypt
  // rule catch any Egyptian Orange story that omits an explicit "مصر" token.
  { id: 'or-eg-en', tier: 1, brand: 'Orange', country: 'Egypt',
    url: gnews('"Orange Egypt" OR "Orange Money"') },
  { id: 'or-eg-ar', tier: 1, brand: 'Orange', country: 'Egypt',
    url: gnews('"أورنج مصر" OR "اورنج مصر" OR "أورنج كاش" OR "اورنج كاش" OR "أورنج إيجيبت"', 'ar') },

  // ---- WE (Telecom Egypt's mobile brand) ----
  // "WE" is a near-useless search token on its own, so anchor it to the
  // parent and the Arabic brand name.
  { id: 'we-eg-en', tier: 1, brand: 'WE', country: 'Egypt',
    url: gnews('"Telecom Egypt" OR "WE" Egypt mobile OR telecom') },
  { id: 'we-eg-ar', tier: 1, brand: 'WE', country: 'Egypt',
    url: gnews('"المصرية للاتصالات" OR "وي" مصر اتصالات', 'ar') },

  // ---- e& Egypt / Etisalat Misr ----
  { id: 'ea-eg-en', tier: 1, brand: 'e&', country: 'Egypt',
    url: gnews('"e& Egypt" OR "Etisalat Misr" OR "Etisalat Egypt" OR "e-and Egypt"') },
  { id: 'ea-eg-ar', tier: 1, brand: 'e&', country: 'Egypt',
    url: gnews('"اتصالات مصر" OR "إي آند مصر"', 'ar') },

  // ---- Cross-brand market / sentiment sweep ----
  // Catches comparative coverage, "best network", outage complaints, price
  // rows and mentions that name more than one operator (the classifier tags
  // the primary brand). Kept broad; the classifier drops the pure noise.
  { id: 'mkt-eg-en', tier: 1, brand: null, country: 'Egypt',
    url: gnews('Egypt mobile operator Vodafone OR Orange OR Etisalat OR "Telecom Egypt" complaint OR outage OR service OR price OR data') },
  { id: 'mkt-eg-ar', tier: 1, brand: null, country: 'Egypt',
    url: gnews('مصر شركات المحمول فودافون OR اورنج OR اتصالات OR "المصرية للاتصالات" شكوى OR انقطاع OR خدمة OR اسعار', 'ar') },
];

// Verified RSS/Atom feeds from Egyptian outlets. Every entry here has been
// probed and returned real items. These carry the OUTLET reliably and, for the
// WordPress-based ones, frequently an AUTHOR byline (<dc:creator>) — which the
// Google-News queries above almost never provide. That is why they matter to a
// PR team that needs "who published it."
//
// Do NOT guess feed URLs — a 404 fails silently and you end up trusting an
// empty radar. Add one at a time, probe first, then commit.
//
// These are broad Egypt outlets, not brand-filtered, so the classifier does the
// "is this about one of our four brands?" filtering. That is intentional: it is
// how you catch a story an outlet ran that the brand-name Google query missed.
export const DIRECT_FEEDS = [
  // Egyptian tech/telecom outlet, English. Operator coverage, product and
  // service stories. WordPress feed — carries author.
  { id: 'technotime', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.technotime.net/feed/' },

  // Daily News Egypt — economy vertical. Business + corporate coverage of the
  // operators. WordPress feed — carries author.
  { id: 'dne-economy', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.dailynewsegypt.com/category/economy/feed/' },

  // Al Borsa News — Egyptian financial daily, Arabic. Heavy market + corporate
  // coverage; catches earnings-driven and financial-reputation stories.
  { id: 'alborsa-ar', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.alborsaanews.com/feed' },

  // Egypt Independent — English general news. Reliable corporate + consumer
  // coverage that complements the Arabic feeds.
  { id: 'egyptindependent', tier: 1, brand: null, country: 'Egypt',
    url: 'https://egyptindependent.com/feed/' },

  // Mada Masr (EN) — independent English-language paper. Longer-form; catches
  // reputation / labour / consumer stories the wire misses.
  { id: 'madamasr-en', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.madamasr.com/en/feed/' },

  // Amwal Al Ghad (English) — Egyptian financial & business daily. Corporate,
  // market and fintech coverage of the operators.
  { id: 'amwalalghad-en', tier: 1, brand: null, country: 'Egypt',
    url: 'https://en.amwalalghad.com/feed/' },

  // ---- Verified by the production probe (Admin → Tools → "Probe feeds") ----
  // Byline counts below are what the probe actually observed, not assumptions.

  // Daily News Egypt — site-wide feed, alongside the economy one above: the
  // economy feed guarantees business coverage, this catches the other desks.
  // 10/10 items carried a byline.
  { id: 'dne-all', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.dailynewsegypt.com/feed/' },

  // Hapi Journal — Egyptian financial daily. 10/10 bylined.
  { id: 'hapi', tier: 1, brand: null, country: 'Egypt',
    url: 'https://hapijournal.com/feed/' },

  // Arab Hardware — Arabic tech/consumer-electronics outlet. 10/10 bylined.
  { id: 'arabhardware', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.arabhardware.net/feed' },

  // Developing Telecoms — international telecom trade press; catches Egypt
  // operator stories the local press frames differently. 34/34 bylined.
  { id: 'developingtelecoms', tier: 1, brand: null, country: 'Egypt',
    url: 'https://developingtelecoms.com/index.php?format=feed&type=rss' },

  // Digital Boom — Arabic tech/telecom consumer outlet. 15/15 bylined.
  { id: 'digitalboom', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.adigitalboom.com/feed/' },

  // NTRA (the telecom regulator) — market-level decisions, tariffs, spectrum.
  // 10/10 bylined. Low volume; the classifier still drops pure rule-making that
  // names no operator (that belongs to the regulatory tracker).
  { id: 'ntra', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.tra.gov.eg/rss' },

  // Aitnews — pan-Arab tech/telecom outlet, Arabic. 10/10 bylined, which is why
  // it earns a direct feed on top of the site: sweep in SITE_FEEDS: the sweep
  // guarantees brand-relevant coverage, this supplies the journalist's name.
  // Pan-Arab, not Egypt-only, so the prefilter passes plenty of Gulf/global
  // telecom items and the classifier's NON-EGYPT rule does the final drop.
  // (Probed 3 Aug: the ONLY one of 31 staged candidates with a working feed.)
  { id: 'aitnews', tier: 1, brand: null, country: 'Egypt',
    url: 'https://aitnews.com/feed/' },

  // Al-Masry Al-Youm — national daily firehose. The ONE verified feed here that
  // carries NO bylines (0/20), so its cards show "· newsroom"; kept for speed and
  // completeness of coverage. The prefilter keeps its football/crime out of the
  // classifier.
  { id: 'almasryalyoum', tier: 1, brand: null, country: 'Egypt',
    url: 'https://www.almasryalyoum.com/rss/rssfeeds' },
];


// ---------------------------------------------------------------------------
// Site-scoped sweeps — named outlets the PR team wants covered explicitly.
//
// Why queries rather than direct RSS: `site:` search is verifiable by
// construction (same endpoint as the brand queries above — no URL to guess and
// no 404 to fail silently), it returns ONLY brand-relevant items from those
// domains, and it works for sites that publish no feed at all (corporate
// newsrooms, regulators). The trade-off is no byline — Google News does not
// carry one. Where an outlet also has a real RSS feed, add it to DIRECT_FEEDS
// as well (probe first): the feed supplies the journalist's name, this supplies
// guaranteed coverage.
//
// Grouped so each query stays short and stays in one language family. Daily run
// only — the 15-min urgent poll keeps to the tight brand queries.
// ---------------------------------------------------------------------------
const AR_BRANDS = '(فودافون OR أورنج OR اورنج OR "اتصالات مصر" OR "المصرية للاتصالات" OR "إي آند")';
const EN_BRANDS = '(Vodafone OR Orange OR Etisalat OR "Telecom Egypt" OR "e& Egypt")';
const sites = (...d) => `(${d.map((x) => `site:${x}`).join(' OR ')})`;

export const SITE_FEEDS = [
  // Business & financial press — Arabic
  { id: 'site-biz-ar', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('almalnews.com', 'alborsaanews.com', 'amwalalghad.com', 'hapijournal.com', 'mubasher.info', 'arabfinance.com', 'asharqbusiness.com', 'cnnbusinessarabic.com')} ${AR_BRANDS}`, 'ar') },

  // Business & financial press — English
  { id: 'site-biz-en', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('enterprise.press', 'dailynewsegypt.com', 'businesstodayegypt.com', 'egypttoday.com', 'zawya.com', 'reuters.com', 'alarabiya.net')} ${EN_BRANDS}`) },

  // Telecom & tech trade press (mixed language)
  { id: 'site-telecom', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('aitnews.com', 'arabhardware.net', 'telecomreviewafrica.com', 'developingtelecoms.com', 'commsupdate.com', 'adigitalboom.com')} ${EN_BRANDS} OR ${AR_BRANDS}`) },

  // National dailies — the two biggest reach drivers, split so neither query
  // gets long enough to be truncated.
  { id: 'site-daily-ar1', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('youm7.com', 'masrawy.com', 'almasryalyoum.com', 'elwatannews.com', 'cairo24.com')} ${AR_BRANDS}`, 'ar') },
  { id: 'site-daily-ar2', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('elbalad.news', 'mobtada.com', 'dostor.org', 'shorouknews.com', 'gate.ahram.org.eg', 'youlyou.com')} ${AR_BRANDS}`, 'ar') },

  // Operator newsrooms — owned announcements. No brand filter: everything on
  // these domains is that operator by definition.
  { id: 'site-newsrooms', tier: 1, brand: null, country: 'Egypt',
    url: gnews(sites('vodafone.com.eg', 'orange.eg', 'etisalat.eg', 'te.eg'), 'ar') },

  // Regulator / exchange / government — only where they touch the mobile
  // market. Pure rule-making with no operator angle belongs to the regulatory
  // tracker, and the classifier drops it.
  { id: 'site-official', tier: 1, brand: null, country: 'Egypt',
    url: gnews(`${sites('tra.gov.eg', 'mcit.gov.eg', 'egx.com.eg', 'cabinet.gov.eg')} (اتصالات OR المحمول OR الإنترنت OR تليكوم)`, 'ar') },
];

// Mark every feed whose items must pass the relevance prefilter (`direct` is
// the flag radar.js turns into `_direct` on each item — see isWorthClassifying).
//
// SITE_FEEDS were assumed query-scoped like FEEDS and exempt — WRONG, proven
// live 5 Aug: Google News does not reliably honour the brand conjunction in
// `(site:…) (brands)` queries and returns the outlets' general firehose.
// One week of it: Al Mal 209 stored / 0 relevant, Reuters 203 / 0 — Ukraine,
// Gaza, heatwaves — ~44% of everything scanned, each row a wasted classifier
// call, and the Health screening-quality rate diluted from 7.1% to 3.3%.
// The prefilter costs a genuinely scoped result nothing (it names a brand or a
// sector term, so it passes); it only stops the junk Google should not have
// returned. The 10 FEEDS brand queries stay exempt: quoted single-brand
// queries are honoured, and the market sweep's terms all pass the filter
// anyway.
export const ALL_FEEDS = [...FEEDS, ...[...SITE_FEEDS, ...DIRECT_FEEDS].map((f) => ({ ...f, direct: true }))];

// ---------------------------------------------------------------------------
// Relevance prefilter — for DIRECT outlet feeds only.
//
// Google-News feeds are already scoped by their query, so everything they
// return is worth classifying. A national daily's feed is not: Youm7 or
// Masrawy publish hundreds of items a day (football, crime, weather) and every
// one of them would otherwise be sent to the classifier — thousands of wasted
// calls daily, and a run long enough to hit the function timeout.
//
// So an item from a DIRECT feed must mention a brand OR a mobile-market term
// before it costs a classifier call. Deliberately GENEROUS: it runs on the
// headline + snippet, covers Arabic and English, and includes sector words with
// no brand in them (outage, price rise, NTRA…) so the market-level stories the
// PR team wants are not filtered out. When in doubt it keeps the item — the
// classifier is still the real filter, this only stops the obvious noise.
const PREFILTER_RE = new RegExp([
  // brands, EN + AR (incl. common spellings/morphology)
  'vodafone', 'orange', 'etisalat', 'telecom egypt', '\\bwe\\b',
  'فودافون', 'ڤودافون', 'أورنج', 'اورنج', 'اتصالات', 'المصرية للاتصالات', 'إي آند', 'اي اند',
  // sector terms — market stories that name no brand
  'mobile operator', 'mobile network', 'telecom', 'telecoms', '5g', '4g', 'sim card',
  'mobile internet', 'call tariff', 'ntra', 'mobile market',
  'المحمول', 'الموبايل', 'الاتصالات', 'شبكة المحمول', 'باقات', 'شرائح',
  'الجهاز القومي لتنظيم الاتصالات', 'تعريفة المكالمات', 'الإنترنت الأرضي',
].join('|'), 'i');

/** Is this item worth a classifier call? Always true for query-scoped feeds;
    direct outlet firehoses must mention a brand or a mobile-market term. */
export function isWorthClassifying(item) {
  if (!item || !item._direct) return true;
  return PREFILTER_RE.test(`${item.headline || ''} ${item.snippet || ''}`);
}


// The urgent-only near-real-time subset — the four operators' own Google News
// queries (entries carrying a `brand`) PLUS the cross-operator market sweep
// (brand:null), excluding only the broad DIRECT_FEEDS outlet firehoses. Used by
// the near-real-time urgent-only poll (api/radar.js?urgentOnly=1): a tight, fast
// net cheap enough to run every 15 min. The market sweep is now INCLUDED so a
// sector-wide outage that doesn't name Vodafone (e.g. "Egypt mobile network
// down") is caught in near-real-time, not only in the daily full run. The daily
// full run still sweeps ALL_FEEDS.
export const BRAND_FEEDS = FEEDS; // brand queries + market sweep (excludes DIRECT_FEEDS)
