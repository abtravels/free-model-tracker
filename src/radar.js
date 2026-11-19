/**
 * Radar: finds *new* free uncensored providers that nobody's model list shows.
 *
 * Two feeds:
 *  1. awesome-free-ai-coding/index.json - 137 providers, each already checked for
 *     "free" + "no card" by its maintainers, with base URLs and probe results.
 *  2. Hugging Face model search - newly published abliterated / uncensored weights.
 *
 * Every provider is probed anonymously before it is reported, and keyless ones are
 * pushed into the Worker's KV so the 15-minute scan starts watching them by itself.
 *
 * Usage: node src/radar.js [--dry] [--verbose]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const VERBOSE = args.has('--verbose') || DRY;

const WEBHOOK = process.env.DISCORD_WEBHOOK ?? '';
const WORKER = process.env.TRACKER_WORKER_URL ?? 'https://free-model-tracker.umair5075.workers.dev';
const RADAR_TOKEN = process.env.RADAR_TOKEN ?? '';
const SEEN_PATH = process.env.RADAR_SEEN ?? 'data/radar-seen.json';

const FEED = 'https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/index.json';
const HF = 'https://huggingface.co/api/models';

const UNCENSORED = /uncensor|abliterat|heretic|euryale|dolphin|lunaris|magnum|mythomax|nsfw|unfiltered/i;
const MAX_POSTS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadSeen() {
  try {
    const raw = await readFile(resolve(SEEN_PATH), 'utf8');
    const j = JSON.parse(raw);
    return { providers: j.providers ?? {}, models: j.models ?? {} };
  } catch {
    return { providers: {}, models: {} };
  }
}

async function saveSeen(seen) {
  const target = resolve(SEEN_PATH);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(seen, null, 2) + '\n', 'utf8');
}

async function fetchJson(url, { timeoutMs = 25_000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'free-model-tracker-radar/1.0', ...headers },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- provider discovery ---------------------------- */

/** Pick free, OpenAI-compatible entries that expose a base URL. */
function pickProviders(index) {
  const out = [];
  for (const e of index?.entries ?? []) {
    if (e.archived) continue;
    if (e.card_required) continue;
    if (!e.api?.base_url) continue;
    if (e.api?.openai_compatible === false) continue;
    if (UNCENSORED.test(`${e.name} ${e.offering} ${(e.api?.model_ids ?? []).join(' ')}`)) {
      out.push({ ...e, why: 'uncensored' });
      continue;
    }
    out.push({ ...e, why: 'free' });
  }
  // Uncensored first, then the rest.
  return out.sort((a, b) => (a.why === 'uncensored' ? -1 : 0) - (b.why === 'uncensored' ? -1 : 0));
}

/** Probe a provider's model catalogue anonymously to learn whether it truly needs a key. */
async function probeProvider(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const urls = /\/v\d+[a-z0-9]*$/i.test(base)
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`];

  for (const u of urls) {
    const r = await fetchJson(u);
    if (r.status === 200 && Array.isArray(r.json?.data)) {
      const ids = r.json.data.map((m) => String(m?.id ?? '')).filter(Boolean);
      return { keyless: true, models: ids, modelsUrl: u };
    }
    if (r.status === 401 || r.status === 403) {
      return { keyless: false, models: [], modelsUrl: u, status: r.status };
    }
  }
  return { keyless: false, models: [], modelsUrl: urls[0], status: 404 };
}

/** Chat probe: /models listing alone proves nothing, a real completion does. */
async function probeChat(modelsUrl, modelIds) {
  const chatUrl = modelsUrl.replace(/\/models$/, '/chat/completions');
  const pick = modelIds.find((id) => UNCENSORED.test(id)) ?? modelIds[0];
  if (!pick) return { ok: false };
  const r = await fetchJson(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    timeoutMs: 40_000,
  });
  if (r.status !== 200) return { ok: false, status: r.status, model: pick };
  const hasChoice = Array.isArray(r.json?.choices);
  return { ok: hasChoice, status: r.status, model: pick };
}

/* ------------------------------ model discovery ------------------------------ */

/** Newly published abliterated / uncensored weights on Hugging Face. */
async function findNewModels(seen, nowMs) {
  const found = [];
  for (const term of ['abliterated', 'uncensored']) {
    const r = await fetchJson(`${HF}?search=${term}&sort=createdAt&direction=-1&limit=40`);
    for (const m of r.json ?? []) {
      const id = String(m?.id ?? '');
      const created = Date.parse(m?.createdAt ?? '');
      if (!id || !Number.isFinite(created)) continue;
      if (nowMs - created > 3 * 86_400_000) continue;   // only the last 3 days
      if ((m.likes ?? 0) < 2 && (m.downloads ?? 0) < 50) continue;
      if (seen.models[id]) continue;
      found.push({ id, likes: m.likes ?? 0, downloads: m.downloads ?? 0, createdAt: m.createdAt, term });
    }
    await sleep(400);
  }
  const unique = new Map();
  for (const m of found) unique.set(m.id, m);
  return [...unique.values()].sort((a, b) => b.likes - a.likes);
}

/* ---------------------------------- Discord --------------------------------- */

function badgeless(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

async function post(embeds, content) {
  if (!WEBHOOK) {
    console.log('[radar] no DISCORD_WEBHOOK, printing only');
    return;
  }
  if (DRY) {
    console.log('[radar] dry run, not posting');
    return;
  }
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Free Model Radar',
        content: i === 0 ? content : undefined,
        embeds: batch,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) console.error('[radar] discord error', res.status, (await res.text()).slice(0, 200));
    if (i + 10 < embeds.length) await sleep(700);
  }
}

/* ----------------------------------- main ----------------------------------- */

async function main() {
  const nowMs = Date.now();
  const seen = await loadSeen();
  const embeds = [];

  // 1. Providers from the verified feed.
  const feed = await fetchJson(FEED);
  if (!feed.json) {
    console.error('[radar] feed unreachable:', feed.status, feed.error ?? '');
  }
  const candidates = pickProviders(feed.json)
    .filter((e) => !seen.providers[e.id])
    .slice(0, 12);

  const keyless = [];
  for (const e of candidates) {
    const p = await probeProvider(e.api.base_url);
    const base = e.api.base_url.replace(/\/+$/, '');
    const modelsUrl = p.modelsUrl;
    const hot = UNCENSORED.test(`${e.name} ${e.offering} ${(e.api.model_ids ?? []).join(' ')}`);
    // A catalogue that opens anonymously still 401s on chat at most gateways.
    const chat = p.keyless && p.models.length ? await probeChat(modelsUrl, p.models) : { ok: false };
    const worksKeyless = chat.ok;

    seen.providers[e.id] = { name: e.name, at: new Date().toISOString(), keyless: worksKeyless };

    if (worksKeyless) keyless.push({ id: e.id, name: e.name, modelsUrl, models: p.models.slice(0, 12) });
    if (!worksKeyless && !hot) continue;             // plain free + needs key = noise
    if (!worksKeyless && !e.api.key_url) continue;   // can't use it, can't get a key

    const tags = [];
    if (hot) tags.push('🔓 uncensored');
    if (e.no_account) tags.push('🙅 no account');
    if (worksKeyless) tags.push('✅ keyless chat');
    else tags.push('🔑 key needed');

    embeds.push({
      title: `🛰 new ${hot ? 'uncensored ' : ''}provider: ${e.name}`,
      url: e.url,
      description: badgeless(e.offering).slice(0, 380),
      color: hot ? 0xff6b35 : 0x5865f2,
      fields: [
        { name: 'Base URL', value: '`' + base + '`', inline: false },
        {
          name: 'Status',
          value: worksKeyless
            ? `✅ answered a live chat with \`${chat.model}\``
            : `🔑 needs a key (chat answered ${chat.status ?? 'n/a'})`,
          inline: false,
        },
        ...(e.api.key_url ? [{ name: 'Key', value: `[get a key](${e.api.key_url})`, inline: true }] : []),
        { name: 'Limits', value: badgeless(e.limits).slice(0, 300) || '—', inline: false },
        ...(tags.length ? [{ name: 'Tags', value: tags.join(' · '), inline: false }] : []),
        { name: 'Verified', value: String(e.last_verified ?? '?'), inline: true },
      ],
      footer: { text: 'Radar · awesome-free-ai-coding feed' },
      timestamp: new Date().toISOString(),
    });
    await sleep(350);
    if (embeds.length >= MAX_POSTS) break;
  }

  // 2. New uncensored weights.
  for (const m of await findNewModels(seen, nowMs)) {
    if (embeds.length >= MAX_POSTS + 4) break;
    seen.models[m.id] = { at: new Date().toISOString() };
    embeds.push({
      title: `🧪 new uncensored weights: ${m.id}`,
      url: `https://huggingface.co/${m.id}`,
      color: 0xff6b35,
      fields: [
        { name: 'Matched', value: m.term, inline: true },
        { name: 'Likes', value: String(m.likes), inline: true },
        { name: 'Downloads', value: String(m.downloads), inline: true },
        { name: 'Published', value: String(m.createdAt).slice(0, 10), inline: true },
      ],
      footer: { text: 'Radar · Hugging Face new releases' },
      timestamp: new Date().toISOString(),
    });
  }

  await saveSeen(seen);

  // 3. Hand keyless endpoints to the worker so the 15-minute scan watches them.
  if (keyless.length && !DRY) {
    const res = await fetch(`${WORKER}/radar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(RADAR_TOKEN ? { 'x-radar-token': RADAR_TOKEN } : {}) },
      body: JSON.stringify({ sources: keyless }),
    }).catch((e) => ({ ok: false, status: 0, text: () => String(e) }));
    console.log('[radar] worker adopt:', res.status, (await res.text()).slice(0, 120));
  }

  if (VERBOSE) {
    console.log(`[radar] providers=${candidates.length} keyless=${keyless.length} embeds=${embeds.length}`);
    for (const k of keyless) console.log(`  + keyless ${k.name} -> ${k.modelsUrl}`);
    for (const e of embeds) console.log(`  • ${e.title}`);
  }

  if (embeds.length) {
    await post(embeds.slice(0, MAX_POSTS + 4), `**Radar** · ${embeds.length} new finding(s) · ${new Date().toUTCString()}`);
  } else {
    console.log('[radar] nothing new');
  }
}

main().catch((err) => {
  console.error('[radar] fatal:', err?.message ?? err);
  process.exitCode = 1;
});
