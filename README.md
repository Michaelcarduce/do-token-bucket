# do-token-bucket

[![CI](https://github.com/Michaelcarduce/do-token-bucket/actions/workflows/ci.yml/badge.svg)](https://github.com/Michaelcarduce/do-token-bucket/actions/workflows/ci.yml)

A token-bucket rate limiter as a Cloudflare Durable Object.

- **One object per key** (`client:resource`), so every decision for that key
  runs on a single thread — no read-modify-write race, which is the reason it
  is a Durable Object and not KV.
- **Lazy refill.** State is `{ tokens, updatedAt }`; tokens are computed from
  elapsed time on each call. No timers, no per-second writes.
- **Self-cleaning.** An alarm deletes the row the moment the bucket is full
  again, because a full bucket is indistinguishable from a fresh one. Idle
  keys cost nothing.
- **SQLite-backed**, so it runs on the Workers free plan.
- **Tested inside workerd** with `@cloudflare/vitest-pool-workers`: real
  storage, real alarms, eviction, concurrency.

Extracted from the rate limiter that guards a write-once route in a React
Native app's Workers backend; context in the
[Kosher Kav case study](https://michael-cardose.vercel.app/work/kosher-kav).

## How it fits

```
client ──▶ Worker ──▶ RATE_LIMITER.getByName("203.0.113.9:/videos/1/view")
                          │
                          ▼
                     TokenBucket DO ── storage: { tokens, updatedAt }
                          │            alarm: wipe when full again
                          ▼
             { allowed, remaining, retryAfterMs, resetMs }
```

## Install

```sh
npm install @michaelcardose/do-token-bucket
```

Export the class from your Worker and bind it in `wrangler.jsonc`:

```ts
// src/worker.ts
export { TokenBucket } from "@michaelcardose/do-token-bucket";
```

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "RATE_LIMITER", "class_name": "TokenBucket" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TokenBucket"] }]
}
```

## Use

The policy travels with each call; the Worker already knows it per route.

```ts
import type { BucketConfig } from "@michaelcardose/do-token-bucket";

// 30 at once, then 120 per hour.
const POLICY: BucketConfig = { capacity: 30, refillPerSecond: 120 / 3600 };

export default {
  async fetch(request, env) {
    const client = request.headers.get("cf-connecting-ip") ?? "anonymous";
    const url = new URL(request.url);
    const bucket = env.RATE_LIMITER.getByName(`${client}:${url.pathname}`);

    const r = await bucket.take(POLICY); // cost defaults to 1
    if (!r.allowed) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) },
      });
    }
    // ...
  },
} satisfies ExportedHandler<Env>;
```

[`src/worker.ts`](src/worker.ts) is the full example, including
`RateLimit-*` headers.

## API

### `TokenBucket` (Durable Object)

| Method | Returns | Notes |
| --- | --- | --- |
| `take(config, cost = 1)` | `TakeResult` | Spend `cost` tokens if available. |
| `peek(config)` | `TakeResult` | Same result shape, spends nothing. |
| `reset()` | `void` | Forget the bucket; next `take` starts full. |

```ts
interface BucketConfig {
  capacity: number;        // burst size, > 0
  refillPerSecond: number; // sustained rate, > 0
}

interface TakeResult {
  allowed: boolean;
  remaining: number;     // whole tokens left
  retryAfterMs: number;  // 0 when allowed
  resetMs: number;       // ms until full again
}
```

Invalid configs (`capacity <= 0`, `refillPerSecond <= 0`, `cost > capacity`,
`NaN`) throw `TokenBucketConfigError` (a `RangeError`). Ordinary limiting
never throws.

### Pure functions

`take`, `refill`, `fullBucket` and `validateConfig` are exported separately.
They take `now` as an argument and return new state, so the arithmetic can be
tested without workerd — see [`test/bucket.test.ts`](test/bucket.test.ts).

## Design notes

**Why not KV?** KV is eventually consistent and has no atomic
compare-and-set; two edge locations can both read `tokens: 1` and both
allow. A Durable Object serialises every call for its key.

**Why one object per key?** Fan-out. A single global limiter object would be
a hot spot; per-key objects spread across the network and each one is tiny.

**Why not store the config?** It would need a migration path when a policy
changes, and the Worker knows the policy anyway. Sending it each call keeps
the object dumb.

**Clock safety.** A clock that appears to go backwards refills nothing rather
than draining; `retryAfterMs` is rounded up so a client that waits exactly
that long is never refused again; float drift across many partial refills is
absorbed by a 1e-9 tolerance.

## Development

```sh
npm install
npm run typecheck   # also regenerates worker-configuration.d.ts
npm test            # Vitest inside workerd
npm run build       # tsup → dist/
npm run dev         # wrangler dev, hit http://localhost:8787 repeatedly
```

## License

MIT
