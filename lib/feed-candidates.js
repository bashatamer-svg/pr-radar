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
//
// ── PROBED 3 Aug from production, twice; 31 candidates, 60 URLs ─────────────
//
// ONE worked: Aitnews (10/10 bylined) — now live in DIRECT_FEEDS. The second
// run added the reason behind each 200, which split the failures into three
// genuinely different things and left only one lead worth chasing:
//
//  * 404 / 403 / 500 on both URLs (22 outlets) — guessed `/rss` and `/feed`
//    suffixes that Egyptian sites overwhelmingly do not use. DISPROVEN and
//    REMOVED from this file so a re-probe stops spending 44 fetches to relearn
//    it: Al Mal, Arab Finance, Business Today Egypt, Egypt Today, Mubasher,
//    Al Arabiya Business, Reuters, Telecom Review Africa, CommsUpdate, Cairo24,
//    El Dostor, El Watan, Masrawy, Mobtada, Sada El Balad, Al Ahram Gate, EGX
//    (timed out twice), Cabinet Media Center, e& Egypt, Telecom Egypt (WE) and
//    Vodafone Egypt newsrooms.
//  * 200 with an HTML PAGE (7 outlets) — the path resolves to a web page, so
//    there is no feed THERE and no suffix left to guess: Amwal Al Ghad (AR),
//    Enterprise, CNN Business Arabic, Zawya, Al Shorouk, Orange Egypt newsroom,
//    MCIT. Also removed; all seven are already covered by a `site:` sweep in
//    SITE_FEEDS, which costs no byline we were otherwise getting.
//  * Something else entirely — the two kept below.
//
// The outlets removed above are NOT dropped from the radar: every one is still
// swept by a query-scoped SITE_FEEDS entry. What a direct feed would have added
// is the journalist's name, and that is what is still missing for them.
export const FEED_CANDIDATES = [
  // Youm7 — the ONE real lead. `SectionRss?SectionID=0` returned a VALID RSS
  // document that simply had no items in it, which means the endpoint shape is
  // right and only the section id is wrong (0 is not a real section). Youm7 is
  // Egypt's biggest news site, so a working section feed is worth having.
  // Kept here as proof-of-shape: the next step is a real SectionID, which has
  // to be read off youm7.com — enumerating ids blindly is the same low-yield
  // guessing that produced the 22 above.
  { id: 'youm7', name: 'Youm7', kind: 'general', urls: ['https://www.youm7.com/rss/SectionRss?SectionID=0'] },

  // Youlyou — Egyptian outlet the team named on 3 Aug. Already swept by
  // `site:youlyou.com` in site-daily-ar2, so its brand coverage lands either
  // way; a direct feed would only add the byline.
  //
  // The last URL is the section page the team pointed at, and it is here NOT as
  // another suffix guess but as autodiscovery bait: when a candidate resolves to
  // an HTML page the probe now reads its <link rel="alternate"> tag and follows
  // whatever feed the site itself declares. Asking the page is the one method
  // that does not depend on guessing the path right.
  { id: 'youlyou', name: 'Youlyou', kind: 'general',
    urls: ['https://www.youlyou.com/rss', 'https://www.youlyou.com/feed', 'https://www.youlyou.com/channel/1'] },

  // Asharq Business — answered 202 with an EMPTY BODY on both URLs. A 202 is
  // "accepted, nothing for you yet", the signature of a bot-protection or
  // queueing layer rather than a missing feed, so unlike the HTML-page group
  // this one is undisproven: the URL may well be correct and simply refused to
  // a datacentre IP. Worth one retry if the other work ever runs out.
  { id: 'asharqbusiness', name: 'Asharq Business', kind: 'business', urls: ['https://www.asharqbusiness.com/rss', 'https://www.asharqbusiness.com/feed'] },
];
