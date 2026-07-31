// Candidate feed URLs awaiting verification — NOT live sources.
//
// House rule (lib/sources.js): never guess a feed URL into the live set. A 404
// fails silently and you end up trusting an empty radar. This file is the
// staging area: Admin → Tools → "Probe feeds" fetches every candidate FROM
// PRODUCTION (the dev sandbox cannot reach news hosts) and reports which ones
// return real items, whether they carry bylines, and a sample headline. Only
// then does a verified URL move into DIRECT_FEEDS.
//
// `kind` records what the outlet is, because it decides HOW to ingest it:
//   'business' / 'telecom' / 'wire' — topically dense; a direct feed is cheap
//        and adds the byline Google News never provides.
//   'general' — a national daily firehose (hundreds of items/day, mostly
//        football/crime/weather). Only worth a direct feed WITH the keyword
//        prefilter in front of the classifier; otherwise use Google News.
//   'newsroom' — the operators' own announcements (owned media).
//   'official' — regulator / exchange / government.

export const FEED_CANDIDATES = [
  // ---- Business & financial press ----
  { id: 'almal', name: 'Al Mal', kind: 'business', urls: ['https://almalnews.com/feed/', 'https://almalnews.com/rss'] },
  { id: 'amwal-ar', name: 'Amwal Al Ghad (AR)', kind: 'business', urls: ['https://amwalalghad.com/feed/', 'https://www.amwalalghad.com/feed/'] },
  { id: 'enterprise', name: 'Enterprise', kind: 'business', urls: ['https://enterprise.press/feed/', 'https://enterprise.press/rss'] },
  { id: 'businesstoday', name: 'Business Today Egypt', kind: 'business', urls: ['https://www.businesstodayegypt.com/rss', 'https://www.businesstodayegypt.com/feed'] },
  { id: 'egypttoday', name: 'Egypt Today', kind: 'business', urls: ['https://www.egypttoday.com/rss', 'https://www.egypttoday.com/feed'] },
  { id: 'arabfinance', name: 'Arab Finance', kind: 'business', urls: ['https://www.arabfinance.com/rss', 'https://www.arabfinance.com/feed'] },
  { id: 'mubasher', name: 'Mubasher', kind: 'business', urls: ['https://www.mubasher.info/rss', 'https://www.mubasher.info/api/1/rss/news'] },
  { id: 'zawya', name: 'Zawya', kind: 'business', urls: ['https://www.zawya.com/en/rss', 'https://www.zawya.com/rss'] },
  { id: 'asharqbusiness', name: 'Asharq Business', kind: 'business', urls: ['https://www.asharqbusiness.com/rss', 'https://www.asharqbusiness.com/feed'] },
  { id: 'cnnbusinessar', name: 'CNN Business Arabic', kind: 'business', urls: ['https://cnnbusinessarabic.com/feed', 'https://cnnbusinessarabic.com/rss'] },
  { id: 'alarabiya-aswaq', name: 'Al Arabiya Business', kind: 'business', urls: ['https://www.alarabiya.net/.mrss/ar/aswaq.xml', 'https://www.alarabiya.net/feed/rss2/ar/aswaq.xml'] },
  { id: 'reuters', name: 'Reuters', kind: 'wire', urls: ['https://www.reuters.com/rssfeed/businessNews', 'https://www.reuters.com/arc/outboundfeeds/rss/'] },

  // ---- Telecom / tech trade ----
  { id: 'aitnews', name: 'Aitnews', kind: 'telecom', urls: ['https://aitnews.com/feed/'] },
  { id: 'telecomreviewafrica', name: 'Telecom Review Africa', kind: 'telecom', urls: ['https://www.telecomreviewafrica.com/rss', 'https://www.telecomreviewafrica.com/index.php?format=feed&type=rss'] },
  { id: 'commsupdate', name: 'TeleGeography CommsUpdate', kind: 'telecom', urls: ['https://www.commsupdate.com/feed/'] },

  // ---- National dailies (firehoses — prefilter required) ----
  { id: 'youm7', name: 'Youm7', kind: 'general', urls: ['https://www.youm7.com/rss/SectionRss?SectionID=0', 'https://www.youm7.com/rss/HomePageRss'] },
  { id: 'masrawy', name: 'Masrawy', kind: 'general', urls: ['https://www.masrawy.com/rss/rssfeeds', 'https://www.masrawy.com/rss'] },
  { id: 'elwatan', name: 'El Watan', kind: 'general', urls: ['https://www.elwatannews.com/rss', 'https://www.elwatannews.com/home/rss'] },
  { id: 'cairo24', name: 'Cairo24', kind: 'general', urls: ['https://www.cairo24.com/rss', 'https://www.cairo24.com/feed'] },
  { id: 'elbalad', name: 'Sada El Balad', kind: 'general', urls: ['https://www.elbalad.news/rss', 'https://www.elbalad.news/feed'] },
  { id: 'mobtada', name: 'Mobtada', kind: 'general', urls: ['https://www.mobtada.com/rss', 'https://www.mobtada.com/feed'] },
  { id: 'dostor', name: 'El Dostor', kind: 'general', urls: ['https://www.dostor.org/rss', 'https://www.dostor.org/feed'] },
  { id: 'shorouk', name: 'Al Shorouk', kind: 'general', urls: ['https://www.shorouknews.com/rss', 'https://www.shorouknews.com/RSS/Rss.aspx'] },
  { id: 'ahramgate', name: 'Al Ahram Gate', kind: 'general', urls: ['https://gate.ahram.org.eg/rss', 'https://gate.ahram.org.eg/News/Rss.aspx'] },

  // ---- Operator newsrooms (owned media) ----
  { id: 'nr-vodafone', name: 'Vodafone Egypt newsroom', kind: 'newsroom', urls: ['https://www.vodafone.com.eg/rss', 'https://www.vodafone.com.eg/feed'] },
  { id: 'nr-orange', name: 'Orange Egypt newsroom', kind: 'newsroom', urls: ['https://www.orange.eg/rss', 'https://www.orange.eg/feed'] },
  { id: 'nr-etisalat', name: 'e& Egypt newsroom', kind: 'newsroom', urls: ['https://www.etisalat.eg/rss', 'https://www.etisalat.eg/feed'] },
  { id: 'nr-te', name: 'Telecom Egypt (WE) newsroom', kind: 'newsroom', urls: ['https://te.eg/rss', 'https://te.eg/feed'] },

  // ---- Regulator / exchange / government ----
  { id: 'mcit', name: 'MCIT', kind: 'official', urls: ['https://mcit.gov.eg/rss', 'https://www.mcit.gov.eg/feed'] },
  { id: 'egx', name: 'EGX', kind: 'official', urls: ['https://www.egx.com.eg/rss', 'https://www.egx.com.eg/en/rss.aspx'] },
  { id: 'cabinet', name: 'Cabinet Media Center', kind: 'official', urls: ['https://www.cabinet.gov.eg/rss', 'https://www.cabinet.gov.eg/feed'] },
];
