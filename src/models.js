/** Normalise a catalogue response into [{ id, name, context, maxOut, promptPrice, completionPrice, modality, params }]. */
export function parseModels(source, payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.data ?? payload?.models ?? payload?.results ?? [];
  if (!Array.isArray(rows)) return [];

  const include = source.include ? new RegExp(source.include, 'i') : null;
  const exclude = source.exclude ? new RegExp(source.exclude, 'i') : null;

  return rows
    .map((row) => toModel(source, row))
    .filter((m) => m.id)
    .filter((m) => !include || include.test(m.id))
    .filter((m) => !exclude || !exclude.test(m.id));
}

function toModel(source, row) {
  const id = String(row?.id ?? row?.model ?? row?.name ?? '').trim();
  const spec = row?.model_spec ?? {};
  const specCaps = spec?.capabilities ?? {};
  const pricing = row?.pricing ?? {};
  const arch = row?.architecture ?? {};
  const params = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];

  // Providers nest prices differently: {prompt}, {input:{usd}}, {input:0.2}, model_spec.pricing...
  let prompt = money(pricing.prompt ?? pricing.input)
    ?? money(spec?.pricing?.input)
    ?? money(row?.price?.input)
    ?? money(row?.input_price);
  let completion = money(pricing.completion ?? pricing.output)
    ?? money(spec?.pricing?.output)
    ?? money(row?.price?.output)
    ?? money(row?.output_price);

  // Some catalogues simply do not publish prices (keyless free endpoints).
  if (source.freeAssumed) {
    if (prompt === null) prompt = 0;
    if (completion === null) completion = 0;
  }
  // Providers quoting per-character / per-1K prices would otherwise look paid.
  if (source.priceScale) {
    prompt = prompt === null ? null : prompt * source.priceScale;
    completion = completion === null ? null : completion * source.priceScale;
  }

  const inMods = Array.isArray(row?.input_modalities) ? row.input_modalities : null;
  const outMods = Array.isArray(row?.output_modalities) ? row.output_modalities : null;
  const modality = arch.modality ?? row?.modality ?? (outMods ? `${inMods?.join('+') ?? 'text'}->${outMods.join('+')}` : null);

  return {
    key: `${source.id}::${id}`,
    sourceId: source.id,
    sourceName: source.name ?? source.id,
    id,
    name: row?.name ?? spec?.name ?? id,
    url: modelUrl(source, id),
    context: int(row?.context_length ?? row?.context_window?.tokens ?? row?.context_window ?? spec?.availableContextTokens ?? row?.limit?.context),
    maxOut: int(row?.maximum_output_length ?? row?.top_provider?.max_completion_tokens ?? spec?.maxCompletionTokens ?? row?.limit?.output),
    promptPrice: prompt,
    completionPrice: completion,
    modality,
    vision: specCaps.supportsVision ?? row?.vision ?? (Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : null),
    tools: specCaps.supportsFunctionCalling ?? row?.tools ?? (params.length ? params.includes('tools') : null),
    reasoning: specCaps.supportsReasoning ?? row?.reasoning ?? (params.length ? params.includes('reasoning') : null),
    // Venice and some gateways flag it explicitly instead of using a name keyword.
    declaredUncensored: row?.uncensored === true || spec?.uncensored === true || (Array.isArray(spec?.traits) && spec.traits.includes('most_uncensored')),
    created: int(row?.created),
  };
}

/** Coerce a price that may be a number, a numeric string, or an object like { usd: 0.2 }. */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return money(v.usd ?? v.price ?? v.value ?? v.amount ?? null);
  return num(v);
}

/** Build a clickable page URL for a model, from the source's modelUrl template. */
function modelUrl(source, id) {
  if (source.modelUrl) return source.modelUrl.replace(/\{id\}/g, id);
  if (source.home) return source.home;
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** A model is free when both prices are known zeros. */
export function isFree(model) {
  return model.promptPrice === 0 && model.completionPrice === 0;
}

/** Match uncensored-style keywords in id or name. */
export function matchesKeywords(model, keywords) {
  const hay = `${model.id} ${model.name}`.toLowerCase();
  return keywords.some((k) => k && hay.includes(String(k).toLowerCase()));
}

let warnedMissing = false;

/** Fetch one source's catalogue. Returns { models } or { error }. */
export async function fetchSource(source, { timeoutMs = 25000, attempts = 3 } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'free-model-tracker/1.0' };
  for (const [k, v] of Object.entries(source.headers ?? {})) {
    if (v) headers[k] = v;
  }
  const auth = source.headers?.Authorization ?? '';
  if (auth.endsWith(' ') && !warnedMissing) {
    warnedMissing = true;
    console.warn(`[warn] a source has an empty bearer token (missing env var?) — it may 401`);
  }

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(source.modelsUrl, { headers, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status} ${text.slice(0, 160)}`;
        if (res.status < 500 && res.status !== 429) return { error: lastError };
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { error: `not JSON: ${text.slice(0, 160)}` };
      }
      return { models: parseModels(source, json) };
    } catch (err) {
      lastError = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(1500 * attempt);
  }
  return { error: lastError };
}

/** True when the model produces text (music / image generators are skipped). */
export function isTextOut(model) {
  if (!model.modality) return true;
  const out = String(model.modality).split('->').pop();
  return /text/i.test(out);
}

/** Chat endpoint for a source: explicit chatUrl, else /models -> /chat/completions. */
export function chatUrlFor(source) {
  if (source.chatUrl) return source.chatUrl;
  return String(source.modelsUrl).replace(/\/models\/?$/, '/chat/completions');
}

/**
 * Send one tiny request to prove the model really answers and really costs 0.
 * Returns { ok, latencyMs } or { ok: false, error }.
 */
export async function probeModel(source, model, { maxTokens = 8, timeoutMs = 75000 } = {}) {
  const url = chatUrlFor(source);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'free-model-tracker/1.0',
  };
  for (const [k, v] of Object.entries(source.headers ?? {})) {
    if (v) headers[k] = v;
  }

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'probe returned non-JSON' };
    }
    const choice = json?.choices?.[0];
    if (!choice) return { ok: false, error: 'probe had no choices' };
    return {
      ok: true,
      latencyMs: Date.now() - started,
      cost: json?.usage?.cost ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? `probe timeout after ${timeoutMs}ms` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
