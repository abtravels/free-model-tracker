import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function loadConfig(path) {
  const raw = await readFile(resolve(path), 'utf8');
  const cfg = JSON.parse(expandEnv(stripBom(raw)));
  if (!cfg.sources?.length) throw new Error('config: at least one source is required');
  if (!Number.isFinite(cfg.intervalMinutes)) cfg.intervalMinutes = 15;
  if (!Number.isFinite(cfg.maxEmbedsPerMessage)) cfg.maxEmbedsPerMessage = 10;
  if (!Array.isArray(cfg.uncensoredKeywords)) cfg.uncensoredKeywords = DEFAULT_KEYWORDS;
  if (!cfg.statePath) cfg.statePath = 'data/seen.json';
  cfg.freeOnly = cfg.freeOnly === true;
  cfg.onlyUncensored = cfg.onlyUncensored === true;
  return cfg;
}

/** Replace ${VAR} with process.env.VAR (empty string when missing). */
function expandEnv(text) {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
}

/** Windows editors save a UTF-8 BOM; JSON.parse rejects it. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function loadState(path) {
  try {
    const raw = await readFile(resolve(path), 'utf8');
    const state = JSON.parse(raw);
    return { seen: state.seen ?? {}, lastRun: state.lastRun ?? null };
  } catch {
    return { seen: {}, lastRun: null };
  }
}

export async function saveState(path, state) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export const DEFAULT_KEYWORDS = ['uncensored', 'abliterated', 'heretic', 'nsfw'];
