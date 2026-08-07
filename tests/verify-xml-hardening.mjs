// Feed XML is third-party input. These cases pin the guards in lib/xml.js:
// a body that never ends must not be buffered, a DTD full of entities must not
// be parsed, and the ordinary RSS/Atom shapes the pipeline reads must be
// completely unaffected by either guard.
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { parseFeedXml, readCapped, readFeedXml, FeedXmlError, MAX_FEED_BYTES, PARSER_OPTIONS } from '../lib/xml.js';

// ── 1. The normal shapes still parse exactly as the pipeline expects ────────
{
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>Youm7</title>
  <item>
    <title>Vodafone &amp; Orange raise prices</title>
    <link>https://youm7.example/1</link>
    <pubDate>Wed, 06 Aug 2026 10:00:00 GMT</pubDate>
    <dc:creator>Jane Doe</dc:creator>
    <description><![CDATA[<p>excerpt body</p>]]></description>
    <source url="https://youm7.example">Youm7</source>
  </item>
</channel></rss>`;
  const x = parseFeedXml(rss);
  const item = x.rss.channel.item;
  assert.strictEqual(item.title, 'Vodafone & Orange raise prices', 'named entities still resolve');
  assert.strictEqual(item.link, 'https://youm7.example/1');
  assert.strictEqual(item['dc:creator'], 'Jane Doe', '<dc:creator> byline still readable');
  assert.strictEqual(item.description, '<p>excerpt body</p>', 'CDATA still unwrapped');
  // Attributes are what Atom's <link href> and RSS <source url> ride on.
  assert.strictEqual(item.source['@_url'], 'https://youm7.example', 'attributes still prefixed @_');
  assert.strictEqual(PARSER_OPTIONS.ignoreAttributes, false, 'attributes are kept');
  assert.strictEqual(PARSER_OPTIONS.attributeNamePrefix, '@_', 'the prefix every caller reads');
}
{
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Orange Egypt outage</title><link href="https://a.example/2"/>
    <published>2026-08-06T09:00:00Z</published><summary>text</summary></entry></feed>`;
  const e = parseFeedXml(atom).feed.entry;
  assert.strictEqual(e.link['@_href'], 'https://a.example/2', 'Atom link href still read');
  assert.strictEqual(e.published, '2026-08-06T09:00:00Z');
}

// ── 2. Billion laughs — a DOCTYPE declaring entities is refused unparsed ────
{
  const boom = `<?xml version="1.0"?><!DOCTYPE lolz [
   <!ENTITY lol "lol">
   <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
   <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
   <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
   <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
  ]><rss><channel><item><title>&lol4;</title></item></channel></rss>`;
  const t0 = Date.now();
  assert.throws(() => parseFeedXml(boom), (e) => e instanceof FeedXmlError && e.code === 'entity-declaration',
    'a DOCTYPE declaring entities is rejected');
  assert.ok(Date.now() - t0 < 1000, 'and rejected immediately — no expansion attempted');
}
// XXE: an external entity pointed at the local filesystem. Same guard catches
// it before the parser, so the refusal does not depend on the parser's own.
{
  const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
    `<rss><channel><item><title>&x;</title></item></channel></rss>`;
  assert.throws(() => parseFeedXml(xxe), (e) => e.code === 'entity-declaration', 'external entity refused');
}
// A DOCTYPE with no entity declarations (some CMSs emit one) is still fine —
// the guard is about entities, not about DTDs, so it cannot kill a live feed.
{
  const ok = `<!DOCTYPE rss PUBLIC "-//X//DTD//EN" "http://x/rss.dtd">` +
    `<rss><channel><item><title>Vodafone Egypt result</title></item></channel></rss>`;
  assert.strictEqual(parseFeedXml(ok).rss.channel.item.title, 'Vodafone Egypt result',
    'a plain DOCTYPE without entity declarations still parses');
}
// And `<!ENTITY` inside CDATA is article text, not a declaration. Killing a
// feed over an outlet writing about XML would be worse than the bug prevented.
{
  const article = `<rss><channel><item><title>How XML works</title>` +
    `<description><![CDATA[Declare one with <!ENTITY name "value"> in the DTD.]]></description>` +
    `</item></channel></rss>`;
  const x = parseFeedXml(article);
  assert.strictEqual(x.rss.channel.item.title, 'How XML works', 'body text mentioning <!ENTITY does not trip the guard');
}

// ── 3. Size caps ───────────────────────────────────────────────────────────
{
  assert.throws(() => parseFeedXml('<a>' + 'x'.repeat(200) + '</a>', { maxBytes: 100 }),
    (e) => e instanceof FeedXmlError && e.code === 'too-large', 'an oversized string is refused');
  assert.strictEqual(MAX_FEED_BYTES, 4 * 1024 * 1024, 'the shipped cap is 4 MB');
}

// A body that keeps coming is ABORTED, not buffered: the reader must be
// cancelled and the promise must reject rather than run the process out of
// memory. `sent` proves we stopped reading rather than draining it all.
{
  let sent = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(c) { sent++; c.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  });
  const res = { body: stream, text: async () => { throw new Error('must not buffer'); } };
  await assert.rejects(() => readCapped(res, 256 * 1024),
    (e) => e instanceof FeedXmlError && e.code === 'too-large', 'an unbounded body is refused');
  assert.ok(cancelled, 'the stream is cancelled so the server stops sending');
  assert.ok(sent < 64, `reading stopped near the cap, not at the end (chunks read: ${sent})`);
}

// Under the cap, readCapped returns byte-identical text to res.text().
{
  const body = '<rss><channel><item><title>مصر — Vodafone</title></item></channel></rss>';
  const bytes = Buffer.from(body, 'utf8');
  const res = { body: Readable.toWeb(Readable.from([bytes])), text: async () => body };
  assert.strictEqual(await readCapped(res), body, 'UTF-8 (including Arabic) round-trips unchanged');
}
// No stream (a mocked response in the older tests) falls back to res.text().
{
  const body = '<rss><channel><item><title>fallback path</title></item></channel></rss>';
  assert.strictEqual(await readCapped({ text: async () => body }), body, 'text() fallback still works');
  await assert.rejects(() => readCapped({ text: async () => 'x'.repeat(50) }, 10),
    (e) => e.code === 'too-large', 'and the fallback applies the same cap');
}

// ── 4. readFeedXml composes both halves ────────────────────────────────────
{
  const body = '<rss><channel><item><title>Vodafone Cash outage reported</title></item></channel></rss>';
  const res = { body: Readable.toWeb(Readable.from([Buffer.from(body)])), text: async () => body };
  const x = await readFeedXml(res);
  assert.strictEqual(x.rss.channel.item.title, 'Vodafone Cash outage reported');
}

// ── 5. One parser for the whole repo ───────────────────────────────────────
// The options were duplicated in api/radar.js and api/admin.js, so hardening
// one left the other reading hostile XML under the old rules. Nothing outside
// lib/xml.js may construct an XMLParser again.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  for (const dir of ['api', 'lib']) {
    for (const f of readdirSync(root + dir).filter((n) => n.endsWith('.js'))) {
      if (dir === 'lib' && f === 'xml.js') continue;
      const src = readFileSync(`${root}${dir}/${f}`, 'utf8');
      assert.ok(!/from ['"]fast-xml-parser['"]/.test(src),
        `${dir}/${f} imports fast-xml-parser directly — parse through lib/xml.js so the guards apply`);
    }
  }
}

console.log('ok verify-xml-hardening');
