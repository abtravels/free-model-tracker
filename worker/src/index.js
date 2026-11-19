/**
 * Free Model Tracker - Cloudflare Worker edition.
 *
 * Same job as the Node tracker in ../src, but triggered by Cloudflare cron
 * (which fires on the clock, unlike GitHub's best-effort schedule) and keeping
 * its "already announced" state in KV instead of a JSON file.
 */

const MAX_PROBES_PER_RUN = 10;     // free plan allows 50 subrequests per invocation
const PROBE_TIMEOUT_MS = 90_000;   // Numes free tier often needs 45-70s to answer
const PROBE_MAX_TOKENS = 8;

const UNCENSORED_KEYWORDS = [
  'uncensored', 'abliterated', 'heretic', 'unaligned', 'unfiltered', 'dolphin', 'nsfw',
];

/** Catalogue sources. `env` names a secret binding; missing secret => source skipped. */
function sources(env) {
  const list = [
    {
      id: 'numes',
      name: 'Numes',
      modelsUrl: 'https://api.numes.ai/api/v1/models',
      modelUrl: 'https://numes.ai/models/{id}',
      key: env.NUMES_KEY,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      modelUrl: 'https://openrouter.ai/{id}',
      key: env.OPENROUTER_KEY,
    },
    {
      id: 'uncensoredllm',
      name: 'UncensoredLLM',
      modelsUrl: 'https://uncensored-llm.sbs/v1/models',
      modelUrl: 'https://uncensored-llm.sbs',
      key: env.UNCENSOREDLLM_KEY,
      freeAssumed: true,
    },
    {
      id: 'pollinations',
      name: 'Pollinations',
      modelsUrl: 'https://text.pollinations.ai/models',
      chatUrl: 'https://text.pollinations.ai/openai',
      modelUrl: 'https://pollinations.ai/',
      freeAssumed: true,
    },
    {
      id: 'zenmux',
      name: 'ZenMux',
      modelsUrl: 'https://zenmux.ai/api/v1/models',
      key: env.ZENMUX_KEY,
    },
    {
      id: 'crowllm',
      name: 'CrowLLM',
      modelsUrl: 'https://crowllm.com/v1/models',
      key: env.CROWLLM_KEY,
    },
    {
      id: 'apinex',
      name: 'APInex',
      modelsUrl: 'https://api.apinex.bond/v1/models',
      key: env.APINEX_KEY,
    },
    {
      id: 'abliteratedmodels',
      name: 'Abliterated Models',
      modelsUrl: 'https://api.abliteratedmodels.cc/v1/models',
      key: env.ABLITERATED_KEY,
    },
    {
      id: 'deepinfra',
      name: 'DeepInfra',
      modelsUrl: 'https://api.deepinfra.com/v1/openai/models',
      key: env.DEEPINFRA_KEY,
    },
  ];
  // Sources that need a key we do not have are dropped, not reported as errors.
  return list.filter((s) => !('key' in s) || s.key);
}

function headersFor(source) {
  const h = { Accept: 'application/json', 'User-Agent': 'free-model-tracker/1.0' };
  if (source.key) h.Authorization = `Bearer ${source.key}`;
  return h;
}

function chatUrlFor(source) {
  if (source.chatUrl) return source.chatUrl;
  return String(source.modelsUrl).replace(/\/models\/?$/, '/chat/completions');
}

function modelUrl(source, id) {
  return source.modelUrl ? source.modelUrl.replace(/\{id\}/g, id) : null;
}

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return money(v.usd ?? v.price ?? v.value ?? v.amount ?? null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = money(v);
  return n === null ? null : Math.round(n);
}

/** Normalise one catalogue row from any of the provider shapes we support. */
function toModel(source, row) {
  const id = String(row?.id ?? row?.model ?? row?.name ?? '').trim();
  if (!id) return null;

  const spec = row?.model_spec ?? {};
  const caps = spec?.capabilities ?? {};
  const pricing = row?.pricing ?? {};
  const arch = row?.architecture ?? {};
  const params = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];

  let prompt = money(pricing.prompt ?? pricing.input)
    ?? money(spec?.pricing?.input)
    ?? money(row?.price?.input)
    ?? money(row?.input_price);
  let completion = money(pricing.completion ?? pricing.output)
    ?? money(spec?.pricing?.output)
    ?? money(row?.price?.output)
    ?? money(row?.output_price);

  if (source.freeAssumed) {
    if (prompt === null) prompt = 0;
    if (completion === null) completion = 0;
  }

  const inMods = Array.isArray(row?.input_modalities) ? row.input_modalities : null;
  const outMods = Array.isArray(row?.output_modalities) ? row.output_modalities : null;

  return {
    key: `${source.id}::${id}`,
    sourceId: source.id,
    sourceName: source.name,
    id,
    name: row?.name ?? spec?.name ?? id,
    url: modelUrl(source, id),
    context: int(row?.context_length ?? row?.context_window?.tokens ?? spec?.availableContextTokens),
    maxOut: int(row?.maximum_output_length ?? row?.top_provider?.max_completion_tokens ?? spec?.maxCompletionTokens),
    promptPrice: prompt,
    completionPrice: completion,
    modality: arch.modality ?? row?.modality ?? (outMods ? `${inMods?.join('+') ?? 'text'}->${outMods.join('+')}` : null),
    vision: caps.supportsVision ?? row?.vision ?? (Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : null),
    tools: caps.supportsFunctionCalling ?? row?.tools ?? (params.length ? params.includes('tools') : null),
    reasoning: caps.supportsReasoning ?? row?.reasoning ?? (params.length ? params.includes('reasoning') : null),
  };
}

function parseModels(source, payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data ?? payload?.models ?? []);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => toModel(source, r)).filter(Boolean);
}

function isFree(m) {
  return m.promptPrice === 0 && m.completionPrice === 0;
}

function isTextOut(m) {
  if (!m.modality) return true;
  return /text/i.test(String(m.modality).split('->').pop());
}

function isUncensored(m) {
  const hay = `${m.id} ${m.name}`.toLowerCase();
  return UNCENSORED_KEYWORDS.some((k) => hay.includes(k));
}

async function fetchSource(source) {
  try {
    const res = await fetch(source.modelsUrl, {
      headers: headersFor(source),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: 'response was not JSON' };
    }
    return { models: parseModels(source, json) };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 150) };
  }
}

/** Prove a model answers (and therefore is not a dead or fake listing). */
async function probeModel(source, model) {
  const started = Date.now();
  try {
    const res = await fetch(chatUrlFor(source), {
      method: 'POST',
      headers: { ...headersFor(source), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: PROBE_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 110)}` };
    const json = JSON.parse(text);
    if (!json?.choices?.[0]) return { ok: false, error: 'probe had no choices' };
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 120) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------- Discord --------------------------------- */

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function buildModelEmbed(model, { uncensored, latencyMs }) {
  const tags = [];
  if (uncensored) tags.push('🔓 uncensored');
  if (model.vision) tags.push('🖼 vision');
  if (model.tools) tags.push('🛠 tools');
  if (model.reasoning) tags.push('🧠 reasoning');

  const fields = [
    { name: 'Source', value: model.sourceName, inline: true },
    { name: 'Price', value: 'FREE', inline: true },
    { name: 'Context', value: model.context ? fmtNum(model.context) : '—', inline: true },
  ];
  if (model.maxOut) fields.push({ name: 'Max output', value: fmtNum(model.maxOut), inline: true });
  if (tags.length) fields.push({ name: 'Capabilities', value: tags.join(' · '), inline: false });
  if (model.url) fields.push({ name: 'Link', value: `[Open ${model.sourceName}](${model.url})`, inline: false });
  fields.push({
    name: 'Live check',
    value: `✅ answered in ${(latencyMs / 1000).toFixed(1)}s`,
    inline: false,
  });

  return {
    title: truncate(model.name || model.id, 250),
    url: model.url || undefined,
    description: `\`${truncate(model.id, 300)}\`` + (model.modality ? `\n${model.modality}` : ''),
    color: uncensored ? 0xff6b35 : 0x3ba55c,
    fields,
    footer: { text: 'Verified free model' },
    timestamp: new Date().toISOString(),
  };
}

async function postEmbeds(webhook, embeds, content) {
  if (!webhook) return { ok: false, error: 'DISCORD_WEBHOOK is not set' };
  const batches = [];
  for (let i = 0; i < embeds.length; i += 10) batches.push(embeds.slice(i, i + 10));

  for (const batch of batches) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Free Model Tracker',
        content,
        embeds: batch,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Discord ${res.status} ${(await res.text()).slice(0, 200)}` };
    }
    if (batches.length > 1) await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: true, sent: embeds.length };
}

/* ----------------------------------- scan ---------------------------------- */

const STATE_KEY = 'seen';

async function loadState(env) {
  if (!env.STATE) return { seen: {}, failures: {} };
  const raw = await env.STATE.get(STATE_KEY, 'json');
  return { seen: raw?.seen ?? {}, failures: raw?.failures ?? {} };
}

async function saveState(env, state) {
  if (!env.STATE) return;
  // Keep the payload small enough for a single KV value.
  const seenKeys = Object.keys(state.seen);
  if (seenKeys.length > 2000) {
    const trimmed = {};
    for (const k of seenKeys.slice(-2000)) trimmed[k] = state.seen[k];
    state.seen = trimmed;
  }
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

async function scan(env) {
  const log = [];
  const errors = [];
  const state = await loadState(env);
  const found = [];
  const candidates = [];
  const activeKeys = new Set();
  const now = new Date().toISOString();

  const active = sources(env);
  for (const source of active) {
    const result = await fetchSource(source);
    if (result.error) {
      errors.push(`${source.name}: ${result.error}`);
      continue;
    }
    for (const model of result.models) {
      if (!isFree(model)) continue;
      if (!isTextOut(model)) continue;
      activeKeys.add(model.key);
      if (state.seen[model.key]) {
        state.seen[model.key].lastSeen = now;
        continue;
      }
      const fails = state.failures[model.key] ?? 0;
      if (fails >= 3) continue;
      candidates.push({
        source,
        model,
        uncensored: isUncensored(model),
      });
    }
  }

  const toProbe = candidates.slice(0, MAX_PROBES_PER_RUN);
  const probes = await mapLimit(toProbe, 3, (c) => probeModel(c.source, c.model));

  toProbe.forEach((c, i) => {
    const p = probes[i];
    if (!p.ok) {
      state.failures[c.model.key] = (state.failures[c.model.key] ?? 0) + 1;
      errors.push(`probe ${c.model.key}: ${p.error}`);
      return;
    }
    delete state.failures[c.model.key];
    state.seen[c.model.key] = {
      source: c.model.sourceId,
      model: c.model.id,
      name: c.model.name,
      free: true,
      uncensored: c.uncensored,
      latencyMs: p.latencyMs,
      firstSeen: now,
      lastSeen: now,
    };
    found.push({ ...c, latencyMs: p.latencyMs });
  });

  // Drop entries whose source disappeared so a comeback alerts again.
  for (const key of Object.keys(state.seen)) {
    if (!activeKeys.has(key) && active.some((s) => s.id === state.seen[key].source)) {
      delete state.seen[key];
    }
  }

  let posted = null;
  if (found.length) {
    const embeds = found.map((f) =>
      buildModelEmbed(f.model, { uncensored: f.uncensored, latencyMs: f.latencyMs }),
    );
    posted = await postEmbeds(
      env.DISCORD_WEBHOOK,
      embeds,
      `**${found.length} new free model(s)** · ${new Date().toUTCString()}`,
    );
    if (!posted.ok) errors.push(`discord: ${posted.error}`);
  }

  await saveState(env, state);

  log.push(
    `sources=${active.length} models=${active.length ? toProbe.length : 0} new=${found.length} seen=${Object.keys(state.seen).length}`,
  );
  for (const f of found) {
    log.push(`+ ${f.model.key} ${f.uncensored ? 'UNCENSORED ' : ''}LIVE ${(f.latencyMs / 1000).toFixed(1)}s`);
  }
  for (const e of errors) log.push(`! ${e}`);

  return { found: found.length, posted, errors, log };
}

export default {
  async scheduled(event, env, ctx) {
    const result = await scan(env);
    console.log(result.log.join('\n'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'free-model-tracker' });
    }

    if (url.pathname === '/scan') {
      const result = await scan(env);
      return Response.json(result);
    }

    if (url.pathname === '/state') {
      const state = await loadState(env);
      const keys = Object.keys(state.seen);
      return Response.json({
        count: keys.length,
        seen: keys.map((k) => ({
          key: k,
          name: state.seen[k].name,
          uncensored: state.seen[k].uncensored,
          firstSeen: state.seen[k].firstSeen,
        })),
        failures: state.failures,
      });
    }

    // One-off migration: import the Node tracker's seen.json so models it
    // already announced are not announced again here.
    if (url.pathname === '/seed' && request.method === 'POST') {
      const body = await request.json();
      const existing = await loadState(env);
      const merged = { seen: { ...existing.seen, ...(body.seen ?? {}) }, failures: existing.failures ?? {} };
      await saveState(env, merged);
      return Response.json({ ok: true, count: Object.keys(merged.seen).length });
    }

    return new Response('free-model-tracker\n\nGET /health\nGET /scan\nGET /state\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
