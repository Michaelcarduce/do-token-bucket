/**
 * Runs inside workerd via @cloudflare/vitest-pool-workers: real Durable
 * Object storage, real alarms, isolated per test.
 */
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BucketConfig } from "../src/bucket.js";
import { POLICY } from "../src/worker.js";

/**
 * Fake timers control `Date.now()` inside the Durable Object too, but alarms
 * are scheduled against workerd's real clock: an alarm set for a time that
 * has already passed fires at once. Base the fake clock a year ahead so
 * alarms only run when a test calls `runDurableObjectAlarm`.
 */
const T0 = Date.now() + 365 * 24 * 3_600_000;
const SMALL: BucketConfig = { capacity: 3, refillPerSecond: 1 };

let counter = 0;
/** A fresh, never-used bucket per call. */
function bucket(name = `client-${counter++}:/route`) {
  return env.RATE_LIMITER.getByName(name);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucket Durable Object", () => {
  it("allows `capacity` takes then denies with retryAfterMs", async () => {
    const stub = bucket();
    for (let i = 0; i < 3; i++) {
      expect((await stub.take(SMALL)).allowed).toBe(true);
    }
    const denied = await stub.take(SMALL);
    expect(denied).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
      resetMs: 3000,
    });
  });

  it("refills with wall-clock time", async () => {
    const stub = bucket();
    for (let i = 0; i < 3; i++) await stub.take(SMALL);
    expect((await stub.take(SMALL)).allowed).toBe(false);

    vi.setSystemTime(T0 + 999);
    expect((await stub.take(SMALL)).allowed).toBe(false);

    vi.setSystemTime(T0 + 1000);
    expect((await stub.take(SMALL)).allowed).toBe(true);
  });

  it("keeps separate buckets per name", async () => {
    const a = bucket("alice:/upload");
    const b = bucket("bob:/upload");
    for (let i = 0; i < 3; i++) await a.take(SMALL);
    expect((await a.take(SMALL)).allowed).toBe(false);
    expect((await b.take(SMALL)).allowed).toBe(true);
  });

  it("persists state across eviction", async () => {
    const stub = bucket("persist:/route");
    for (let i = 0; i < 3; i++) await stub.take(SMALL);

    await evictDurableObject(stub);

    const again = env.RATE_LIMITER.getByName("persist:/route");
    expect((await again.take(SMALL)).allowed).toBe(false);
  });

  it("stores only { tokens, updatedAt } and schedules an alarm for reset time", async () => {
    const stub = bucket();
    const result = await stub.take(SMALL);
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get("state");
      expect(stored).toEqual({ tokens: 2, updatedAt: T0 });
      expect(await state.storage.getAlarm()).toBe(T0 + result.resetMs);
    });
  });

  it("the alarm wipes a bucket that has refilled to full", async () => {
    const stub = bucket();
    await stub.take(SMALL);
    vi.setSystemTime(T0 + 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(new Map());
    });
    expect((await stub.take(SMALL)).remaining).toBe(2);
  });

  it("does not keep a row for a full bucket", async () => {
    const stub = bucket();
    await stub.take(SMALL, 0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("peek reports without spending", async () => {
    const stub = bucket();
    await stub.take(SMALL);
    expect((await stub.peek(SMALL)).remaining).toBe(2);
    expect((await stub.peek(SMALL)).remaining).toBe(2);
  });

  it("reset forgets the bucket", async () => {
    const stub = bucket();
    for (let i = 0; i < 3; i++) await stub.take(SMALL);
    await stub.reset();
    expect((await stub.take(SMALL)).remaining).toBe(2);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("surfaces config errors to the caller", async () => {
    const stub = bucket();
    await expect(stub.take({ capacity: 0, refillPerSecond: 1 })).rejects.toThrow(
      /capacity must be/,
    );
    await expect(stub.take(SMALL, 4)).rejects.toThrow(/exceeds capacity/);
  });

  it("serialises concurrent takes: never over-admits", async () => {
    const stub = bucket();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => stub.take(SMALL)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});

describe("example Worker", () => {
  it("returns 200 with RateLimit headers, then 429 with Retry-After", async () => {
    const headers = { "cf-connecting-ip": `203.0.113.${counter++}` };
    let last: Response | undefined;
    for (let i = 0; i < POLICY.capacity; i++) {
      last = await SELF.fetch("https://example.com/videos/1/view", { headers });
      expect(last.status).toBe(200);
    }
    expect(last!.headers.get("ratelimit-limit")).toBe("30");
    expect(last!.headers.get("ratelimit-remaining")).toBe("0");

    const limited = await SELF.fetch("https://example.com/videos/1/view", { headers });
    expect(limited.status).toBe(429);
    // 120/h = one token every 30 s
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(await limited.json()).toMatchObject({ error: "rate_limited", allowed: false });
  });

  it("buckets are per (client, path)", async () => {
    const headers = { "cf-connecting-ip": `203.0.113.${counter++}` };
    for (let i = 0; i < POLICY.capacity; i++) {
      await SELF.fetch("https://example.com/a", { headers });
    }
    expect((await SELF.fetch("https://example.com/a", { headers })).status).toBe(429);
    expect((await SELF.fetch("https://example.com/b", { headers })).status).toBe(200);
  });
});
