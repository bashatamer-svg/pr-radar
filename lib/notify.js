// Optional outbound push for URGENT (importance-5) alerts.
//
// Point URGENT_WEBHOOK_URL at a Slack / Teams / Discord incoming webhook to get
// the alert in a channel, or at a Zapier / Make (Integromat) hook that forwards
// to WhatsApp / SMS — the payload carries both a ready-to-post `text` field and
// a structured `item` object, so a no-code bridge can map it however it likes.
//
// Fail-soft and dormant: with no env set it is a no-op, and any error is
// swallowed so a webhook can never delay or block the urgent email or the
// daily bulletin.

const actionLine = (soWhat) => {
  const first = String(soWhat || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return first.replace(/^Action\s*[·:\-–—]\s*/i, '').trim();
};

export async function postUrgentWebhook(item, boardUrl) {
  const url = process.env.URGENT_WEBHOOK_URL;
  if (!url) return false;

  const token = process.env.RADAR_TOKEN;
  const deep = boardUrl
    ? `${boardUrl}${token ? `?t=${encodeURIComponent(token)}` : ''}${item.id ? `#item-${item.id}` : ''}`
    : (item.url || '');
  const act = actionLine(item.so_what);
  const text = [
    `🚨 URGENT — ${item.headline}`,
    act ? `→ ${act}` : '',
    deep,
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, // Slack / Teams / Discord render this directly
        item: {
          headline: item.headline,
          url: item.url,
          importance: item.importance,
          tier: item.tier,
          country: item.country,
          regulator: item.regulator,
          so_what: item.so_what,
          board_url: deep,
        },
      }),
    });
    if (!res.ok) console.error('urgent webhook non-ok', item.hash, res.status);
    return res.ok;
  } catch (e) {
    console.error('urgent webhook failed', item.hash, e.message);
    return false;
  }
}
