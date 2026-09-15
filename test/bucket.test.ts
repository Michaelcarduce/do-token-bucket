import { describe, expect, it } from "vitest";
import {
  fullBucket,
  refill,
  take,
  TokenBucketConfigError,
  type BucketConfig,
  type BucketState,
} from "../src/bucket.js";

const HOUR = 3_600_000;
/** The policy from the case study: 30 burst, 120 per hour. */
const POLICY: BucketConfig = { capacity: 30, refillPerSecond: 120 / 3600 };
const T0 = 1_700_000_000_000;

function drain(config: BucketConfig, n: number, now: number) {
  let state: BucketState | undefined;
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = take(state, config, 1, now);
    state = r.state;
    results.push(r.result);
  }
  return { state: state!, results };
}

describe("take", () => {
  it("treats an unknown bucket as full", () => {
    const { result } = take(undefined, POLICY, 1, T0);
    expect(result).toEqual({
      allowed: true,
      remaining: 29,
      retryAfterMs: 0,
      resetMs: 30_000,
    });
  });

  it("allows exactly `capacity` requests in a burst, then denies", () => {
    const { results } = drain(POLICY, 31, T0);
    expect(results.slice(0, 30).every((r) => r.allowed)).toBe(true);
    expect(results[29]!.remaining).toBe(0);
    expect(results[30]).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("reports retryAfterMs as the time until one token exists", () => {
    const { state } = drain(POLICY, 30, T0);
    const { result } = take(state, POLICY, 1, T0);
    // 120/h = 1 token every 30s
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.resetMs).toBe(30 * 30_000);
  });

  it("does not spend tokens on a denied take", () => {
    const { state } = drain(POLICY, 30, T0);
    const denied = take(state, POLICY, 1, T0 + 10_000);
    expect(denied.result.allowed).toBe(false);
    expect(denied.state.tokens).toBeCloseTo(10 / 30, 10);
  });

  it("allows again once retryAfterMs has elapsed, and not before", () => {
    const { state } = drain(POLICY, 30, T0);
    const { result: denied } = take(state, POLICY, 1, T0);
    const early = take(state, POLICY, 1, T0 + denied.retryAfterMs - 1);
    const onTime = take(state, POLICY, 1, T0 + denied.retryAfterMs);
    expect(early.result.allowed).toBe(false);
    expect(onTime.result.allowed).toBe(true);
  });

  it("refills to capacity after an hour of quiet, never beyond", () => {
    const { state } = drain(POLICY, 30, T0);
    const later = refill(state, POLICY, T0 + 10 * HOUR);
    expect(later.tokens).toBe(30);
    expect(later.updatedAt).toBe(T0 + 10 * HOUR);
  });

  it("sustains the long-run rate: 120 per hour after the burst", () => {
    let state: BucketState | undefined;
    let allowed = 0;
    // One attempt every 10 s for an hour = 360 attempts.
    for (let i = 0; i <= 360; i++) {
      const r = take(state, POLICY, 1, T0 + i * 10_000);
      state = r.state;
      if (r.result.allowed) allowed++;
    }
    expect(allowed).toBe(30 + 120);
  });

  it("supports a cost other than 1", () => {
    const cfg: BucketConfig = { capacity: 10, refillPerSecond: 1 };
    const a = take(undefined, cfg, 4, T0);
    const b = take(a.state, cfg, 4, T0);
    const c = take(b.state, cfg, 4, T0);
    expect(a.result).toMatchObject({ allowed: true, remaining: 6 });
    expect(b.result).toMatchObject({ allowed: true, remaining: 2 });
    expect(c.result).toMatchObject({ allowed: false, remaining: 2, retryAfterMs: 2000 });
  });

  it("cost 0 is a read-only probe", () => {
    const { state } = drain(POLICY, 5, T0);
    const probe = take(state, POLICY, 0, T0);
    expect(probe.result).toMatchObject({ allowed: true, remaining: 25 });
    expect(probe.state).toEqual(state);
  });

  it("floors `remaining` so callers never see fractional tokens", () => {
    const { state } = drain(POLICY, 30, T0);
    const { result } = take(state, POLICY, 0, T0 + 45_000); // 1.5 tokens refilled
    expect(result.remaining).toBe(1);
  });
});

describe("clock safety", () => {
  it("a clock that goes backwards refills nothing and does not drain", () => {
    const { state } = drain(POLICY, 10, T0);
    const back = refill(state, POLICY, T0 - HOUR);
    expect(back.tokens).toBe(20);
    expect(back.updatedAt).toBe(T0);
  });

  it("fullBucket is exactly at capacity", () => {
    expect(fullBucket(POLICY, T0)).toEqual({ tokens: 30, updatedAt: T0 });
  });
});

describe("config errors", () => {
  it.each([
    [{ capacity: 0, refillPerSecond: 1 }],
    [{ capacity: -1, refillPerSecond: 1 }],
    [{ capacity: Number.NaN, refillPerSecond: 1 }],
    [{ capacity: Number.POSITIVE_INFINITY, refillPerSecond: 1 }],
    [{ capacity: 10, refillPerSecond: 0 }],
    [{ capacity: 10, refillPerSecond: -1 }],
    [{ capacity: 10, refillPerSecond: Number.NaN }],
  ])("rejects config %j", (config) => {
    expect(() => take(undefined, config, 1, T0)).toThrow(TokenBucketConfigError);
  });

  it("rejects a cost that could never be served", () => {
    expect(() => take(undefined, POLICY, 31, T0)).toThrow(TokenBucketConfigError);
    expect(() => take(undefined, POLICY, -1, T0)).toThrow(TokenBucketConfigError);
    expect(() => take(undefined, POLICY, Number.NaN, T0)).toThrow(TokenBucketConfigError);
  });

  it("is a RangeError so generic handlers still catch it", () => {
    expect(() => take(undefined, POLICY, 31, T0)).toThrow(RangeError);
  });
});
