// ── THE BYLINE CASE LEDGER ────────────────────────────────────────────────
// Every byline mistake ever reported against the live board, as data.
// This file is NOT a test — `verify-byline-cases.mjs` replays it. It is
// excluded from the runner the same way `narr-fixture.mjs` is.
//
// WHEN A WRONG BYLINE IS REPORTED, ADD A CASE HERE FIRST. It should FAIL.
// Then fix lib/author.js until it passes, and every earlier case still does.
// That order matters: a case written after the fix only proves the fix exists,
// not that it addresses what was actually reported. The full playbook is in
// CLAUDE.md under "When a wrong byline is reported".
//
// Fields:
//   id        kebab-case, unique, names the FAULT not the site
//   reported  ISO date it reached us
//   outlet    passed to the extractor — the outlet-name rule needs it
//   why       one line: what a reader saw, and why it was wrong
//   expect    the byline that MUST come out. null = show nothing rather than
//             this; honest absence always beats a confident wrong name
//   rule      (raw cases) the judgeByline reason that must fire. Pinning the
//             REASON, not just the null, stops a case passing for the wrong
//             cause after a refactor
//   raw       a bare candidate string, judged directly …
//   html      … or the markup, run through the whole cascade
//   headline  the story's headline, when the case turns on it
//
// Cases are grouped by what they defend. Both halves matter equally: the
// rejections stop wrong names, and the acceptances stop an over-eager guard
// quietly deleting real journalists — which has happened twice.

export const REJECT = [
  {
    id: 'astro-attribute-residue',
    reported: '2026-08-06',
    outlet: 'الخبر لايف',
    why: 'A capture hopped to a ">" inside an attribute value, so it ran from mid-href, past the closing quote, into Astro\'s data-astro-cid-*. The board credited an article to a URL fragment.',
    raw: 'بريد-لتسهيل-تقديم-التظلمات" data-astro-c',
    rule: 'markup',
    expect: null,
  },
  {
    id: 'headline-plus-tag-residue',
    reported: '2026-08-06',
    outlet: 'صدى البلد',
    why: 'Same fault, different site: another article\'s headline plus a stray \'">\'. Found by sweeping pr_items for the first case, which is why the sweep is in the playbook.',
    raw: 'الثانوية ليست نهاية المطاف!">',
    rule: 'markup',
    expect: null,
  },
  {
    id: 'bare-url-slug',
    reported: '2026-08-06',
    outlet: 'الخبر لايف',
    why: 'The same leak also offers a clean hyphen-joined slug with no markup characters at all, so the quote rule cannot catch it.',
    raw: 'بريد-لتسهيل-تقديم-التظلمات',
    rule: 'slug',
    expect: null,
  },
  {
    id: 'cms-admin-email',
    reported: '2026-07',
    outlet: 'ekhbary24',
    why: 'Author metas routinely carry the site administrator\'s mailbox, which is a CMS account, not a journalist.',
    raw: 'admin@ekhbary24.com',
    rule: 'email',
    expect: null,
  },
  {
    id: 'outlet-as-person',
    reported: '2026-07',
    outlet: 'بوابة الأخبار',
    why: 'Feeds drop the publication into <dc:creator>. Rendering a masthead as a person is a small lie the board should never tell.',
    raw: 'بوابة الأخبار',
    rule: 'outlet-name',
    expect: null,
  },
  {
    id: 'desk-byline',
    reported: '2026-07',
    outlet: 'الشروق',
    why: 'Unsigned desk copy is genuinely authorless — "newsroom" is the honest rendering, not a name.',
    raw: 'محرر',
    rule: 'desk-word',
    expect: null,
  },
  {
    id: 'search-box-placeholder',
    reported: '2026-07',
    outlet: 'صدى البلد',
    why: 'A visible-byline pattern scraped the search box template string.',
    raw: 'كلمة البحث هنا',
    rule: 'ui-junk',
    expect: null,
  },
  {
    id: 'interviewee-as-author',
    reported: '2026-08-06',
    outlet: 'Ahram Online',
    why: 'An interview was filed under the byline of the CEO being interviewed — it puts words in a named person\'s mouth on a board the team reads as fact.',
    headline: 'INTERVIEW| Egypt mobile wallet market triples since COVID, Axis Pay targets 3 mln users: Axis CEO Jacques Marco',
    html: '<article><h1>INTERVIEW| Axis Pay targets 3 mln users</h1><meta name="author" content="Jacques Marco"><p>Jacques Marco, CEO of Axis Pay, said the market has tripled.</p></article>',
    expect: null,
  },
];

export const ACCEPT = [
  {
    id: 'dateline-byline-no-marker',
    reported: '2026-08-06',
    outlet: 'Ahram Online',
    why: 'The real byline carries no "By" and no byline class — just a name, a comma and the date. The first version of the subject guard ATE it, because the headline\'s own "CEO" sat nine characters away.',
    html: '<article><h1>Egypt mobile wallet market triples</h1><p>Doaa A.Moneim , Thursday 6 Aug 2026</p><p>The market has tripled since COVID.</p></article>',
    headline: 'Egypt mobile wallet market triples since COVID',
    expect: 'Doaa A.Moneim',
  },
  {
    id: 'outlet-prefixed-credit',
    reported: '2026-07',
    outlet: 'Fintech Gate',
    why: 'A compound credit: the publication, then the journalist. Keep the person, drop the masthead. The quote-verb guard was once loose enough to reject this, because the next sentence began "Vodafone Egypt said".',
    raw: 'Fintech Gate: Riham Ali',
    expect: 'Riham Ali',
  },
  {
    id: 'five-part-arabic-name',
    reported: '2026-08-06',
    outlet: 'الشروق',
    why: 'Egyptian bylines run long. looksLikePerson caps at four words to guard the multi-segment split; applying that cap to a whole name would silently delete real journalists.',
    raw: 'أحمد محمد عبد الله السيد',
    expect: 'أحمد محمد عبد الله السيد',
  },
  {
    id: 'hyphenated-and-apostrophe-names',
    reported: '2026-08-06',
    outlet: null,
    why: 'The slug rule counts hyphens. One per token is a real name (Jean-Pierre, Abdel-Rahman); two in one token is a path segment.',
    raw: 'Abdel-Rahman El-Sayed',
    expect: 'Abdel-Rahman El-Sayed',
  },
  {
    id: 'wordpress-author-link',
    reported: '2026-07',
    outlet: 'Daily News Egypt',
    why: 'The commonest WordPress shape, and the reason the /author/ pattern exists at all.',
    html: '<article><a href="/author/sara-aggour/">Sara Aggour</a><h1>Story</h1></article>',
    expect: 'Sara Aggour',
  },
  {
    id: 'ahram-author-query-param',
    reported: '2026-08-06',
    outlet: 'Ahram Online',
    why: 'Ahram links journalists as a QUERY parameter, which the path-segment pattern missed entirely.',
    html: '<article><a href="/Search.aspx?author=1234">Doaa A.Moneim</a><h1>Story</h1></article>',
    expect: 'Doaa A.Moneim',
  },
  {
    id: 'schema-org-microdata',
    reported: '2026-08-06',
    outlet: null,
    why: 'Coverage gap found while consolidating the funnel: microdata is common and was going straight to the AI fallback. Safe to add only because every candidate is now vetted identically.',
    html: '<article><h1>Story</h1><span itemprop="author">Mohamed Hamada</span></article>',
    expect: 'Mohamed Hamada',
  },
  {
    id: 'html5-address-element',
    reported: '2026-08-06',
    outlet: null,
    why: 'Same sweep: <address> is HTML5\'s own byline element and was unread.',
    html: '<article><h1>Story</h1><address>By Mona Said</address></article>',
    expect: 'Mona Said',
  },
  {
    id: 'generic-author-class',
    reported: '2026-08-06',
    outlet: null,
    why: 'Same sweep: class="author" is far commoner than the "byline" spelling the cascade knew.',
    html: '<article><h1>Story</h1><span class="post-author">Ahmed Fathy</span></article>',
    expect: 'Ahmed Fathy',
  },
];
