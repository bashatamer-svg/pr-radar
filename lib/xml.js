// The ONE XML entry point. Every byte parsed here arrived from a third party —
// a news outlet's RSS endpoint, or whatever answers on a candidate URL during a
// feed probe — so this module treats feed XML as hostile input and is the only
// place `fast-xml-parser` is constructed.
//
// Three guards, each answering a way a hostile or merely broken feed can hurt a
// 60-second serverless function:
//
//   1. SIZE. `fetchFeed` used to do `await res.text()`, which buffers whatever
//      the server sends. A feed that answers 200 with a 500 MB body (hostile, or
//      a CMS looping) is an out-of-memory kill of the whole run — 30 feeds are
//      fetched in parallel, so one of them can take the other 29 down with it.
//      `readCapped` streams and aborts the moment the cap is passed, so the cost
//      of a hostile body is bounded at MAX_FEED_BYTES rather than unbounded.
//
//   2. ENTITY EXPANSION. "Billion laughs" is a DOCTYPE internal subset that
//      declares entities referring to each other, so a few hundred bytes expand
//      to gigabytes. fast-xml-parser does not expand DTD-declared entities and
//      refuses external ones outright — but that is a property of the current
//      version, not a contract, and this app has no use for a DTD at all: no
//      real RSS or Atom feed carries one. So a DOCTYPE that declares entities is
//      rejected before the parser sees it, and the guard is ours rather than
//      borrowed from a dependency's current behaviour.
//
//   3. ONE OPTION SET. The options were duplicated in `api/radar.js` and
//      `api/admin.js`, so hardening one left the other reading hostile XML under
//      the old rules. There is now one `PARSER_OPTIONS`.
//
// What is deliberately NOT changed: `processEntities` stays ON. The named and
// numeric entities it resolves (`&amp;`, `&#8220;`) are exactly what real feeds
// carry, and `api/radar.js` decodes a SECOND layer on top for Google News'
// double-encoding. Turning it off would push that whole job onto a decoder that
// was only ever written to unwrap the second layer.

import { XMLParser } from 'fast-xml-parser';

/** Hard ceiling on a feed body. Egypt's busiest outlet feed is ~200 KB; the
    biggest thing this app has ever fetched is well under a megabyte. 4 MB is
    twenty times the real-world maximum and still small enough that thirty of
    them cannot exhaust a serverless function. */
export const MAX_FEED_BYTES = 4 * 1024 * 1024;

/** The single parser configuration. Attributes are kept (Atom's
    `<link href>` and `<source url>` are read as `@_href` / `@_url`), which is
    the shape every caller in this repo already expects. */
export const PARSER_OPTIONS = Object.freeze({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Named + numeric entities only. fast-xml-parser throws on an external
  // entity (`SYSTEM "file:///etc/passwd"`), and the DOCTYPE guard below stops
  // internal declarations reaching it either way.
  processEntities: true,
  // Do NOT also resolve the HTML entity set. Feed text is frequently
  // HTML-escaped body copy, and expanding it here would hand the classifier
  // (and the board) markup that the pipeline believes it has already stripped.
  htmlEntities: false,
});

const parser = new XMLParser(PARSER_OPTIONS);

/** Errors this module raises carry a `code` so a caller can tell a hostile feed
    from a merely broken one without matching on message text. */
export class FeedXmlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedXmlError';
    this.code = code;
  }
}

/** Reject a DOCTYPE that declares entities.

    Scans ONLY the doctype declaration, never the document body: `<!ENTITY`
    can legitimately appear inside a CDATA section of an article about XML, and
    killing a live outlet feed over that would be a worse bug than the one being
    prevented. Returns nothing; throws when the document must not be parsed. */
function rejectEntityDeclarations(xml) {
  const at = xml.search(/<!DOCTYPE/i);
  if (at === -1) return;                       // the normal case — feeds have no DTD
  // The internal subset ends at `]`, an external-only doctype at the first `>`.
  const close = xml.indexOf(']', at);
  const end = close === -1 ? xml.indexOf('>', at) : close;
  const doctype = xml.slice(at, end === -1 ? Math.min(at + 8192, xml.length) : end + 1);
  if (/<!ENTITY/i.test(doctype)) {
    throw new FeedXmlError('entity-declaration', 'feed declares XML entities (rejected unparsed)');
  }
}

/** Parse feed XML with every guard applied.
    → the parsed object; throws `FeedXmlError` on a body this app refuses to
    read, and whatever fast-xml-parser throws on genuinely malformed XML. */
export function parseFeedXml(xml, { maxBytes = MAX_FEED_BYTES } = {}) {
  const text = String(xml ?? '');
  // Char length, not byte length: it is the cheap upper bound, and a string
  // this long has already been paid for. `readCapped` is what actually bounds
  // the cost; this catches a caller that built the string some other way.
  if (text.length > maxBytes) {
    throw new FeedXmlError('too-large', `feed XML too large (${text.length} chars > ${maxBytes})`);
  }
  rejectEntityDeclarations(text);
  return parser.parse(text);
}

/** Read a fetch Response body as text, aborting past `maxBytes`.

    Drop-in for `await res.text()` except that a body which keeps coming is
    cancelled instead of buffered. Decoding is UTF-8, which is what
    `Response.text()` does too (the spec ignores the Content-Type charset), so
    swapping one for the other cannot change how a feed's text is decoded. */
export async function readCapped(res, maxBytes = MAX_FEED_BYTES) {
  const body = res?.body;
  if (!body || typeof body.getReader !== 'function') {
    // No stream to read incrementally (a mocked response in the tests, an
    // older runtime). Fall back to buffering, then apply the same cap.
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new FeedXmlError('too-large', `feed body too large (${text.length} chars > ${maxBytes})`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength ?? value.length ?? 0;
      if (total > maxBytes) {
        throw new FeedXmlError('too-large', `feed body exceeds ${maxBytes} bytes — aborted`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Cancelling a finished reader is a no-op; cancelling a live one is the
    // point — it tells the server to stop sending.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch-and-parse in one call, with both guards. Used by every feed reader. */
export async function readFeedXml(res, { maxBytes = MAX_FEED_BYTES } = {}) {
  return parseFeedXml(await readCapped(res, maxBytes), { maxBytes });
}
