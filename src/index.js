import { loadConfig, loadState, saveState } from './config.js';
import { fetchSource, isFree, matchesKeywords } from './models.js';
import { postEmbeds, buildModelEmbed, buildScanSummary, sleep } from './discord.js';
import { discoverGithub, buildRepoTrackEmbed } from './discover.js';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY = args.has('--dry');
const VERBOSE = args.has('--verbose') || DRY;

const CONFIG_PATH = process.env.TRACKER_CONFIG || 'config.json';

async function runOnce(config, state) {
  const errors = [];
  const found = [];
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
      const interesting = free || (uncensored && !config.onlyUncensored ? true : uncensored);
      if (!interesting) continue;
      if (config.onlyUncensored && !uncensored) continue;

      activeKeys.add(model.key);
      const prev = state.seen[model.key];
      if (prev) {
        prev.lastSeen = now;
        prev.price = free ? 0 : prev.price;
        continue;
      }
      state.seen[model.key] = {
        source: model.sourceId,
        model: model.id,
        name: model.name,
        context: model.context,
        free,
        uncensored,
        firstSeen: now,
        lastSeen: now,
      };
      found.push({ model, uncensored, free });
    }
  }

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
    console.log(`[scan] ${now} sources ok=${sourcesOk} failed=${sourcesFailed} models=${totalModels} new=${found.length} repos=${repoHits.length}`);
    for (const f of found) {
      console.log(`  + ${f.model.key}  ${f.free ? 'FREE' : 'PRICE'}${f.uncensored ? ' UNCENSORED' : ''}  ctx=${f.model.context ?? '?'}  ${f.model.url ?? ''}`);
    }
    for (const h of repoHits) {
      console.log(`  ★ ${h.repo.full_name}  ⭐${h.repo.stargazers_count}  ${h.repo.html_url}`);
    }
    for (const e of errors) console.log(`  ! ${e}`);
  }

  if (DRY) return;

  const embeds = [
    ...found.map((f) => buildModelEmbed(f.model, { uncensored: f.uncensored })),
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
