import { loadConfig, loadState, saveState } from './config.js';
import { fetchSource, isFree, isTextOut, matchesKeywords, probeModel } from './models.js';
import { postEmbeds, buildModelEmbed, buildScanSummary, sleep } from './discord.js';
import { discoverGithub, buildRepoTrackEmbed } from './discover.js';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY = args.has('--dry');
const VERBOSE = args.has('--verbose') || DRY;

const CONFIG_PATH = process.env.TRACKER_CONFIG || 'config.json';

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runOnce(config, state) {
  const errors = [];
  const found = [];
  const candidates = [];
  let sourcesOk = 0;
  let sourcesFailed = 0;
  let totalModels = 0;
  const now = new Date().toISOString();
  const activeKeys = new Set();

  for (const source of config.sources) {
    const result = await fetchSource(source);
    if (result.error) {
      sourcesFailed++;
      errors.push(`${source.name ?? source.id}: ${result.error}`);
      continue;
    }
    sourcesOk++;
    totalModels += result.models.length;

    for (const model of result.models) {
      const uncensored = matchesKeywords(model, config.uncensoredKeywords);
      const free = isFree(model);
      // freeOnly  -> announce only models with a 0/0 price (uncensored ones still highlighted)
      // onlyUncensored -> ignore plain free models that are not uncensored
      if (config.freeOnly && !free) continue;
      if (config.onlyUncensored && !uncensored) continue;
      if (!free && !uncensored) continue;
      // Music / image generators have no text output, skip them.
      if (!isTextOut(model)) continue;

      activeKeys.add(model.key);
      const prev = state.seen[model.key];
      if (prev) {
        prev.lastSeen = now;
        prev.price = free ? 0 : prev.price;
        continue;
      }
      candidates.push({ source, model, uncensored, free });
    }
  }

  // Live check: a catalogue can list a model that is dead / mispriced / unfree.
  // Only announce what actually answers a 1-token request.
  const verify = config.verify ?? {};
  const probeLimit = Number.isFinite(verify.maxProbesPerRun) ? verify.maxProbesPerRun : 12;
  let toProbe = candidates;
  if (verify.enabled) {
    toProbe = candidates.slice(0, probeLimit);
  }
  const probes = verify.enabled
    ? await mapLimit(toProbe, verify.concurrency ?? 4, async (c) => {
        if (!c.free) return { ok: true, skipped: true };
        const r = await probeModel(c.source, c.model, {
          maxTokens: verify.maxTokens ?? 8,
          timeoutMs: verify.timeoutMs ?? 75000,
        });
        return r;
      })
    : toProbe.map(() => ({ ok: true }));

  toProbe.forEach((c, idx) => {
    const p = probes[idx] ?? { ok: true };
    if (!p.ok) {
      errors.push(`probe ${c.model.key}: ${p.error}`);
      return; // leave unseen -> retried next run
    }
    state.seen[c.model.key] = {
      source: c.model.sourceId,
      model: c.model.id,
      name: c.model.name,
      context: c.model.context,
      free: c.free,
      uncensored: c.uncensored,
      verified: !!verify.enabled,
      latencyMs: p.latencyMs ?? null,
      firstSeen: now,
      lastSeen: now,
    };
    found.push({ ...c, verified: !!verify.enabled, latencyMs: p.latencyMs ?? null });
  });

  // Forget models that vanished from every source so a comeback alerts again.
  for (const key of Object.keys(state.seen)) {
    if (!activeKeys.has(key)) {
      const entry = state.seen[key];
      const sourceSeen = config.sources.some((s) => s.id === entry.source);
      if (sourceSeen) delete state.seen[key];
    }
  }

  state.lastRun = now;

  // Optional: scan GitHub for new providers that publish free APIs.
  let repoHits = [];
  if (config.discovery?.enabled) {
    const gh = await discoverGithub(config, state, now);
    repoHits = gh.found;
    errors.push(...gh.errors);
  }

  if (!DRY) await saveState(config.statePath, state);

  const stats = {
    sourcesOk,
    sourcesFailed,
    totalModels,
    newCount: found.length + repoHits.length,
  };

  if (VERBOSE) {
    console.log(`[scan] ${now} sources ok=${sourcesOk} failed=${sourcesFailed} models=${totalModels} candidates=${candidates.length} new=${found.length} repos=${repoHits.length}`);
    for (const f of found) {
      const live = f.verified ? ` LIVE ${f.latencyMs ? (f.latencyMs / 1000).toFixed(1) + 's' : ''}` : '';
      console.log(`  + ${f.model.key}  ${f.free ? 'FREE' : 'PRICE'}${f.uncensored ? ' UNCENSORED' : ''}${live}  ctx=${f.model.context ?? '?'}  ${f.model.url ?? ''}`);
    }
    for (const h of repoHits) {
      console.log(`  ★ ${h.repo.full_name}  ⭐${h.repo.stargazers_count}  ${h.repo.html_url}`);
    }
    for (const e of errors) console.log(`  ! ${e}`);
  }

  if (DRY) return;

  const embeds = [
    ...found.map((f) => buildModelEmbed(f.model, { uncensored: f.uncensored, verified: f.verified, latencyMs: f.latencyMs })),
    ...repoHits.map((h) => buildRepoTrackEmbed(h)),
  ];

  if (embeds.length) {
    await postEmbeds(config.discordWebhook, embeds, {
      content: embeds.length > 0
        ? `**${found.length} new model(s)** · **${repoHits.length} new source repo(s)** · ${new Date().toUTCString()}`
        : undefined,
    });
    console.log(`[post] sent ${embeds.length} embed(s)`);
  } else if (process.env.SUMMARY_ALWAYS === '1') {
    await postEmbeds(config.discordWebhook, [buildScanSummary(stats, errors)]);
    console.log('[post] summary sent');
  } else {
    console.log('[post] nothing new');
  }
}

function inQuietHours(quiet) {
  if (!quiet) return false;
  const h = new Date().getHours();
  if (quiet.start <= quiet.end) return h >= quiet.start && h < quiet.end;
  return h >= quiet.start || h < quiet.end;
}

async function main() {
  const config = await loadConfig(CONFIG_PATH);
  const state = await loadState(config.statePath);

  if (ONCE) {
    await runOnce(config, state);
    return;
  }

  console.log(`[tracker] running every ${config.intervalMinutes} min · ${config.sources.length} sources`);
  for (;;) {
    try {
      if (inQuietHours(config.quietHours)) {
        console.log('[tracker] quiet hours, skipping post');
      } else {
        await runOnce(config, state);
      }
    } catch (err) {
      console.error('[tracker] scan failed:', err?.message ?? err);
    }
    await sleep(config.intervalMinutes * 60_000);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
