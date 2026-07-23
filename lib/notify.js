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

// Pull the "Action · …" line out of the classifier's 3-line pr_angle
// (Read / Audience / Action). We want the ACTION specifically — the step the
// comms team should take — not the first line (which is the "Read"). Returns ''
// when there is no usable Action line.
const actionFromAngle = (prAngle) => {
  for (const raw of String(prAngle || '').split(/\r?\n+/)) {
    const m = raw.trim().match(/^action\s*[·:\-–—]\s*(.*)$/i);
    if (m) {
      const v = m[1].trim();
      if (v && !/^[—–\-·.\s]*$/.test(v)) return v;
    }
  }
  return '';
};

export async function postUrgentWebhook(item, boardUrl) {
  const url = process.env.URGENT_WEBHOOK_URL;
  if (!url) return false;

  // No ?t= — the board ignores it now (Bearer-session auth); a shared token in a
  // webhook message is pure leak surface. The #item-<id> anchor still deep-links.
  const deep = boardUrl
    ? `${boardUrl}${item.id ? `#item-${item.id}` : ''}`
    : (item.resolved_url || item.url || '');

  // PR Radar items carry pr_angle / brand / sentiment / importance — NOT the
  // Regulatory Radar's so_what / regulator / tier this was ported from. Build
  // the alert from the fields that actually exist on a pr_items row.
  const brand = item.brand || 'Market';
  const spread = Array.isArray(item._instances)
    ? item._instances.filter((x) => x && (x.outlet || x.url)).length
    : 0;
  const act = actionFromAngle(item.pr_angle);

  const text = [
    `🚨 URGENT · ${brand}${spread > 1 ? ` · ${spread} outlets` : ''} — ${item.headline}`,
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
          url: item.resolved_url || item.url,
          brand: item.brand,
          sentiment: item.sentiment,
          importance: item.importance,
          category: item.category,
          country: item.country,
          summary: item.summary,
          pr_angle: item.pr_angle,
          action: act,
          outlets: spread || undefined,
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

// Aggregate SURGE push — one message per surging brand (cross-item spike, not a
// single story). Same env, same fail-soft/dormant contract as the urgent
// webhook above: no URGENT_WEBHOOK_URL → no-op; any error is swallowed so a
// webhook can never delay or block the surge email.
export async function postSurgeWebhook(surge, boardUrl) {
  const url = process.env.URGENT_WEBHOOK_URL;
  if (!url) return false;

  // No ?t= — the board ignores it now (Bearer-session auth); a shared token in a
  // webhook message is pure leak surface.
  const deep = boardUrl || '';
  const top = Array.isArray(surge.topStories) ? surge.topStories.slice(0, 3) : [];

  const text = [
    `▲ SURGE · ${surge.brand} — negative coverage ${surge.multiple}× normal`,
    `${surge.today} weighted-negative today vs a ${surge.windowDays}-day norm of ~${surge.mean}`,
    ...top.map((s) => `• ${s.headline} (${s.outlets} outlet${s.outlets === 1 ? '' : 's'})`),
    deep,
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        surge: {
          brand: surge.brand,
          today: surge.today,
          baseline: surge.mean,
          stddev: surge.stddev,
          threshold: surge.threshold,
          multiple: surge.multiple,
          window_days: surge.windowDays,
          top_stories: top,
          board_url: deep,
        },
      }),
    });
    if (!res.ok) console.error('surge webhook non-ok', surge.brand, res.status);
    return res.ok;
  } catch (e) {
    console.error('surge webhook failed', surge.brand, e.message);
    return false;
  }
}
