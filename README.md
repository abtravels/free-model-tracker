# Free Model Tracker

Watches OpenAI-compatible providers for **new free / uncensored models** and posts
them to a Discord webhook — with a **clickable link** to each model's page. It also
scans GitHub for **new providers** that publish free APIs, so you hear about
sources you don't already know.

Zero dependencies (Node 20+ built-in `fetch`).

## Quick start

```bash
cp config.example.json config.json     # add your webhook
node src/index.js --once --dry         # preview, nothing is posted or saved
node src/index.js --once               # one real scan -> Discord
node src/index.js                      # loop forever (15 min default)
```

Windows: `run-once.cmd` reads keys from `~/.config/opencode/*-api-key.txt` so it can
be driven by Task Scheduler.

## What it does

1. Polls every configured source's `GET /models` (3 attempts, so a flaky DNS blip
   doesn't drop a source).
2. A model is interesting when its prompt **and** completion price are `0`, or when
   its id/name matches an uncensored keyword (abliterated, heretic, uncensored, …).
3. Posts one embed per hit: source, price, context, max output, capability tags
   (🖼 vision · 🛠 tools · 🧠 reasoning) and an **Open link** to the model page.
4. **GitHub discovery** (`discovery.enabled`) searches repos that share free /
   uncensored APIs. Noise is filtered out (VPN lists, proxy lists, resumes, …): a
   repo must look AI-related *and* free/API-related. New repos arrive as
   `🆕 owner/repo` embeds with stars and description.
5. Every hit is stored in `data/seen.json` keyed by `source::modelId`, so nothing is
   announced twice. A model that disappears from a source is forgotten, so if it
   comes back it alerts again.

## Config

| key | meaning |
| --- | --- |
| `discordWebhook` | full webhook URL (secret — keep it out of git) |
| `intervalMinutes` | loop interval, default 15 |
| `sources` | `{ id, name, modelsUrl, modelUrl?, home?, headers? }` |
| `modelUrl` | template for the per-model page, `{id}` is replaced |
| `uncensoredKeywords` | lowercase substrings that flag a model as interesting |
| `onlyUncensored` | `true` posts only uncensored hits |
| `discovery` | `{ enabled, minStars, maxAgeDays, githubQueries }` |
| `quietHours` | optional `{ start: 0, end: 7 }` local hours without posts |
| `statePath` | where `seen.json` lives |

`${ENV_VAR}` anywhere in the JSON is replaced from the environment, so keys never
live in the file:

```json
{ "id": "numes", "name": "Numes",
  "modelsUrl": "https://api.numes.ai/api/v1/models",
  "modelUrl": "https://numes.ai/models/{id}",
  "headers": { "Authorization": "Bearer ${NUMES_KEY}" } }
```

## Running 24/7 for free (GitHub Actions)

`.github/workflows/scan.yml` runs every 15 minutes in a public repo (unlimited
minutes) and keeps `data/seen.json` between runs via `actions/cache`.

1. Push this repo (public).
2. **Settings → Secrets and variables → Actions** → add:
   - `DISCORD_WEBHOOK` (required)
   - `NUMES_KEY`, `ZENMUX_KEY`, `CROWLLM_KEY`, `APINEX_KEY` (only the ones you use)
3. **Actions** tab → enable the `scan` workflow → *Run workflow* to test.

`GITHUB_TOKEN` is provided automatically and used for the discovery search, which
raises the search rate limit from 10 to 30 requests/minute.

## Security

The webhook URL is a password: anyone with it can post to your channel. Keep it in
`DISCORD_WEBHOOK` / `config.json` (git-ignored), never in the repo. Leaked? Open the
webhook in Discord → *Regenerate*.
