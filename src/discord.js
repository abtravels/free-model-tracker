const MAX_DESC = 3800;

/**
 * Send embeds to a Discord webhook.
 * @param {string} webhookUrl
 * @param {object[]} embeds
 * @param {{ username?: string, content?: string }} [opts]
 */
export async function postEmbeds(webhookUrl, embeds, opts = {}) {
  if (!webhookUrl) throw new Error('discordWebhook is not set (env DISCORD_WEBHOOK?)');
  const username = opts.username ?? 'Free Model Tracker';

  const chunks = [];
  const per = 10;
  for (let i = 0; i < embeds.length; i += per) chunks.push(embeds.slice(i, i + per));

  const results = [];
  for (const batch of chunks) {
    const body = JSON.stringify({
      username,
      content: opts.content,
      embeds: batch,
      allowed_mentions: { parse: [] },
    });
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord ${res.status}: ${text.slice(0, 300)}`);
    }
    results.push(res.status);
    // stay well inside the 30 requests/minute per-webhook budget
    await sleep(600);
  }
  return results;
}

/** Build one embed describing a newly discovered model. */
export function buildModelEmbed(model, { uncensored = false } = {}) {
  const free = model.promptPrice === 0 && model.completionPrice === 0;
  const price = free
    ? 'FREE'
    : `${fmtPrice(model.promptPrice)} / ${fmtPrice(model.completionPrice)} per Mtok`;

  const tags = [];
  if (uncensored) tags.push('🔓 uncensored');
  if (model.vision) tags.push('🖼 vision');
  if (model.tools) tags.push('🛠 tools');
  if (model.reasoning) tags.push('🧠 reasoning');

  const fields = [
    { name: 'Source', value: model.sourceName, inline: true },
    { name: 'Price', value: price, inline: true },
    { name: 'Context', value: model.context ? fmtNum(model.context) : '—', inline: true },
  ];
  if (model.maxOut) fields.push({ name: 'Max output', value: fmtNum(model.maxOut), inline: true });
  if (tags.length) fields.push({ name: 'Capabilities', value: tags.join(' · '), inline: false });
  if (model.url) fields.push({ name: 'Link', value: `[Open ${model.sourceName}](${model.url})`, inline: false });

  return {
    title: truncate(model.name || model.id, 250),
    url: model.url || undefined,
    description: '`' + truncate(model.id, 300) + '`' + (model.modality ? `\n${model.modality}` : ''),
    color: uncensored ? 0xff6b35 : free ? 0x3ba55c : 0x5865f2,
    fields,
    footer: { text: free ? 'Free model detected' : 'Uncensored model detected' },
    timestamp: new Date().toISOString(),
  };
}

export function buildScanSummary(stats, errors) {
  const lines = [
    `Sources OK: **${stats.sourcesOk}** · failed: **${stats.sourcesFailed}**`,
    `Models seen: **${stats.totalModels}** · new: **${stats.newCount}**`,
  ];
  if (errors.length) {
    lines.push('', '**Errors**');
    for (const e of errors.slice(0, 6)) lines.push(`• ${truncate(e, 180)}`);
  }
  return {
    title: 'Scan summary',
    description: truncate(lines.join('\n'), MAX_DESC),
    color: stats.sourcesFailed ? 0xe0a030 : 0x57f287,
    timestamp: new Date().toISOString(),
  };
}

function fmtPrice(v) {
  if (v === null || v === undefined) return '?';
  if (v === 0) return '0';
  return '$' + Number(v).toFixed(6);
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
