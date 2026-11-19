// Seed the Worker's KV state from the Node tracker's data/seen.json so models
// that were already announced are not announced a second time.
import { readFile } from 'node:fs/promises';

const file = process.argv[2] ?? '../data/seen.json';
const url = process.argv[3] ?? 'https://free-model-tracker.umair5075.workers.dev';

const local = JSON.parse(await readFile(file, 'utf8'));
const entries = Object.entries(local.seen ?? {});
console.log(`local seen entries: ${entries.length}`);

// The worker only lists source/model/firstSeen through /state, so we rebuild
// the state map and push it with a small admin endpoint.
const payload = {
  seen: Object.fromEntries(
    entries.map(([key, v]) => [
      key,
      {
        source: v.source,
        model: v.model,
        name: v.name,
        free: v.free ?? true,
        uncensored: v.uncensored ?? false,
        latencyMs: v.latencyMs ?? null,
        firstSeen: v.firstSeen,
        lastSeen: v.lastSeen,
      },
    ]),
  ),
  failures: {},
};

const res = await fetch(`${url}/seed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
console.log('seed status:', res.status, await res.text());
