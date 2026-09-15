/**
 * Example Worker: the wiring around the Durable Object. `wrangler dev` serves
 * this; the library itself is `./index.ts`.
 */
import { TokenBucketConfigError, type BucketConfig } from "./bucket.js";
import { TokenBucket } from "./rate-limiter.js";

export { TokenBucket };

/** 30 requests at once, then 120 per hour — one bucket per (client, resource). */
export const POLICY: BucketConfig = { capacity: 30, refillPerSecond: 120 / 3600 };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const client = request.headers.get("cf-connecting-ip") ?? "anonymous";
    const stub = env.RATE_LIMITER.getByName(`${client}:${url.pathname}`);

    let result;
    try {
      result = await stub.take(POLICY);
    } catch (err) {
      if (err instanceof TokenBucketConfigError) {
        return new Response(err.message, { status: 500 });
      }
      throw err;
    }

    const headers = new Headers({
      "content-type": "application/json",
      "ratelimit-limit": String(POLICY.capacity),
      "ratelimit-remaining": String(result.remaining),
      "ratelimit-reset": String(Math.ceil(result.resetMs / 1000)),
    });
    if (!result.allowed) {
      headers.set("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
      return new Response(JSON.stringify({ error: "rate_limited", ...result }), {
        status: 429,
        headers,
      });
    }
    return new Response(JSON.stringify({ ok: true, ...result }), { headers });
  },
} satisfies ExportedHandler<Env>;
