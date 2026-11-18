/** Discover new sources: GitHub repos that share free / uncensored model APIs. */

const API = 'https://api.github.com/search/repositories';

const DEFAULT_QUERIES = [
  { label: 'free LLM API list', q: 'free llm api key list in:readme' },
  { label: 'openai-compatible free proxy', q: 'openai compatible free api in:readme' },
  { label: 'uncensored model api', q: 'uncensored abliterated api in:readme' },
];

export async function discoverGithub(config, state, nowIso) {
  const found = [];
  const errors = [];
  const queries = config.discovery?.githubQueries?.length
    ? config.discovery.githubQueries
    : DEFAULT_QUERIES;
  const minStars = config.discovery?.minStars ?? 2;
  const maxAgeDays = config.discovery?.maxAgeDays ?? 45;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;

  for (const { label, q } of queries) {
    const url = `${API}?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=20`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'free-model-tracker/1.0',
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
      });
      if (!res.ok) {
        errors.push(`github "${label}": HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      for (const repo of json.items ?? []) {
        if ((repo.stargazers_count ?? 0) < minStars) continue;
        if (repo.pushed_at && new Date(repo.pushed_at).getTime() < cutoff) continue;
        if (repo.fork) continue;
        if (!isRelevantRepo(repo)) continue;
        const key = `gh::${repo.full_name}`;
        if (state.seen[key]) {
          state.seen[key].lastSeen = nowIso;
          continue;
        }
        state.seen[key] = {
          source: 'github',
          model: repo.full_name,
          name: repo.full_name,
          free: true,
          uncensored: /uncensor|abliterat|heretic|nsfw/i.test(`${repo.name} ${repo.description ?? ''}`),
          firstSeen: nowIso,
          lastSeen: nowIso,
        };
        found.push({
          repo,
          label,
          uncensored: state.seen[key].uncensored,
        });
      }
    } catch (err) {
      errors.push(`github "${label}": ${err?.message ?? err}`);
    }
    await sleep(2000); // stay under the 10 req/min unauthenticated search limit
  }
  return { found, errors };
}

/**
 * GitHub search matches any word in the README, so it returns plenty of noise
 * (VPN lists, resume tools...). Keep only repos that plausibly describe an AI
 * API source: AI keyword AND a free / API-sharing keyword, and no negative one.
 */
const NEGATIVE = /\b(vpn|shadowsocks|v2ray|clash|trojan|proxy[-\s]?list|proxylist|socks5|scorecard|resume|recipe|wallpaper|crypto[-\s]?miner)\b/i;
const AI_TERM = /\b(llm|gpt|openai|inference|genai|chatbot|completions?|multimodal|mistral|llama|qwen|deepseek|gemini|claude|diffusion|text[-\s]?to[-\s]?(text|image)|ai)\b/i;
const FREE_TERM = /\b(free|uncensored|abliterat\w*|heretic|api[-\s]?keys?|gateway|router|proxy|compatible|aggregator|list|awesome)\b/i;

export function isRelevantRepo(repo) {
  const hay = `${repo.name} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`;
  if (NEGATIVE.test(hay)) return false;
  return AI_TERM.test(hay) && FREE_TERM.test(hay);
}

export function buildRepoTrackEmbed({ repo, label, uncensored }) {
  const stars = repo.stargazers_count ?? 0;
  const fields = [
    { name: 'Stars', value: `⭐ ${stars}`, inline: true },
    { name: 'Language', value: repo.language ?? '—', inline: true },
    { name: 'Updated', value: repo.pushed_at ? repo.pushed_at.slice(0, 10) : '—', inline: true },
    { name: 'Matched', value: label, inline: false },
    { name: 'Repo', value: `https://github.com/${repo.full_name}`, inline: false },
  ];
  return {
    title: `🆕 ${truncate(repo.full_name, 240)}`,
    url: repo.html_url,
    description: truncate(repo.description || 'No description', 500),
    color: uncensored ? 0xff6b35 : 0x9b59b6,
    fields,
    footer: { text: 'New free-API source candidate' },
    timestamp: new Date().toISOString(),
  };
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
