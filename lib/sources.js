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
];

export const ALL_FEEDS = [...FEEDS, ...DIRECT_FEEDS];
