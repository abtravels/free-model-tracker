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

## Radar (finding providers nobody lists)

`src/radar.js` is a separate, daily sweep. It does not read `/v1/models` of known
sources; it hunts for **new sources that are callable with an API key**:

- **Curated provider feed** — `awesome-free-ai-coding/index.json` (137 providers,
  each already marked "free" / "no card" by its maintainers, with base URLs and
  key pages). Entries that are uncensored or keyless get an anonymous `/models`
  probe and then a real `max_tokens: 8` chat probe. A provider that answers chat
  with no key is adopted by the 15-minute scan automatically; the rest are
  reported as "key needed" with their key page.
- **GitHub README crawl** — searches repos that talk about free / uncensored
  OpenAI-compatible APIs, mines their READMEs for `…/v1` base URLs, drops hosts
  already known, and probes what is left. Keyless ones get adopted by the scan;
  keyed ones are reported with the repo that documents them.

No GGUF / weight repos: everything reported is an HTTP endpoint, not a download.

Findings are de-duplicated by `data/radar-seen.json`.

```bash
npm run radar:dry     # preview, posts nothing
npm run radar         # real sweep
```

## Cloudflare Worker (recommended scheduler)

GitHub Actions cron is best-effort: in practice it fired only twice in 25 hours
instead of every 15 minutes. `worker/` runs the same scan on Cloudflare's cron,
which fires on the clock.

```bash
cd worker
npx wrangler kv namespace create STATE    # put the id in wrangler.toml
npx wrangler secret put DISCORD_WEBHOOK   # repeat for each *_KEY you have
npx wrangler deploy
```

Live endpoints:

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /scan` | run a scan now and return the log |
| `GET /state` | remembered models, last run summary and probe cooldowns |
| `GET /scan?silent=1` | remember everything currently listed without probing or posting |
| `POST /seed` | one-off import of `data/seen.json` so old models are not re-announced |

Already-announced state lives in the `STATE` KV namespace, not a file, so each
invocation stays stateless. Sources whose API key secret is missing are skipped
instead of erroring. A failed probe backs off (30 min → 1 h → 3 h → 6 h) and is
retried after that instead of being blacklisted, because free endpoints fail
randomly (Numes answers in 45-70 s and sometimes returns 520).

## What it does

1. Polls every configured source's `GET /models` (3 attempts, so a flaky DNS blip
   doesn't drop a source).
2. A model is interesting when its prompt **and** completion price are `0`, or when
   its id/name matches an uncensored keyword (abliterated, heretic, uncensored, …).
3. Posts one embed per hit: source, price, context, max output, capability tags
   (🖼 vision · 🛠 tools · 🧠 reasoning) and an **Open link** to the model page.
4. **Live check before posting** (`verify.enabled`): sends a tiny `max_tokens: 8`
   request to the model. Only models that actually answer get announced, so a
   catalogue listing that is dead, mispriced, or requires credentials nobody has
   (OpenRouter's `:free` models answer `401 No cookie auth credentials found`)
   never reaches Discord. Failures are retried on the next run instead of posted.
   Each verified embed shows the measured latency (`✅ answered in 57.2s`).
4. **GitHub discovery** (`discovery.enabled`) searches repos that share free /
   uncensored APIs. Noise is filtered out (VPN lists, proxy lists, resumes, …): a
   repo must look AI-related *and* free/API-related. New repos arrive as
   `🆕 owner/repo` embeds with stars and description.
5. Every hit is stored in `data/seen.json` keyed by `source::modelId`, so nothing is
   announced twice. A model that is merely missing from one run (free catalogues
   rotate their models hourly) stays remembered; only entries unseen for 30 days
   are forgotten, so rotations never re-announce the same model.

## Config

| key | meaning |
| --- | --- |
| `discordWebhook` | full webhook URL (secret — keep it out of git) |
| `intervalMinutes` | loop interval, default 15 |
| `sources` | `{ id, name, modelsUrl, modelUrl?, home?, headers? }` |
| `modelUrl` | template for the per-model page, `{id}` is replaced |
| `uncensoredKeywords` | lowercase substrings that flag a model as interesting |
| `freeOnly` | `true` = only models whose prompt **and** completion price are 0 |
| `verify` | `{ enabled, maxTokens, timeoutMs, concurrency, maxProbesPerRun }` — live check before posting |
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
