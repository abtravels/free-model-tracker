/** Normalise a catalogue response into [{ id, name, context, maxOut, promptPrice, completionPrice, modality, params }]. */
export function parseModels(source, payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.data ?? payload?.models ?? payload?.results ?? [];
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => toModel(source, row))
    .filter((m) => m.id);
}

function toModel(source, row) {
  const id = String(row?.id ?? row?.model ?? row?.name ?? '').trim();
  const pricing = row?.pricing ?? {};
  const prompt = num(pricing.prompt ?? pricing.input ?? row?.price?.input);
  const completion = num(pricing.completion ?? pricing.output ?? row?.price?.output);
  const arch = row?.architecture ?? {};
  const params = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];

  return {
    key: `${source.id}::${id}`,
    sourceId: source.id,
    sourceName: source.name ?? source.id,
    id,
    name: row?.name ?? id,
    url: modelUrl(source, id),
    context: int(row?.context_length ?? row?.context_window ?? row?.limit?.context),
    maxOut: int(row?.maximum_output_length ?? row?.top_provider?.max_completion_tokens ?? row?.limit?.output),
    promptPrice: prompt,
    completionPrice: completion,
    modality: arch.modality ?? row?.modality ?? null,
    vision: Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : null,
    tools: params.length ? params.includes('tools') : null,
    reasoning: params.length ? params.includes('reasoning') : null,
    created: int(row?.created),
  };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
