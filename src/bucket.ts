/**
 * Pure token-bucket arithmetic. No clocks, no storage, no timers: every
 * function takes `now` (ms) and returns a new state, so it can be unit-tested
 * in plain Node and reused by the Durable Object in `./rate-limiter.ts`.
 */

export interface BucketConfig {
  /** Maximum tokens the bucket holds — the burst size. Must be > 0. */
  capacity: number;
  /** Tokens added per second while below capacity. Must be > 0. */
  refillPerSecond: number;
}

export interface BucketState {
  /** Tokens available at `updatedAt`. Always in [0, capacity]. */
  tokens: number;
  /** Epoch ms of the last refill/take. */
  updatedAt: number;
}

export interface TakeResult {
  /** Whether `cost` tokens were removed. */
  allowed: boolean;
  /** Tokens left after this call (floored to a whole number). */
  remaining: number;
  /**
   * When denied: ms until enough tokens exist for the same `cost`.
   * When allowed: 0.
   */
  retryAfterMs: number;
  /** Ms until the bucket is full again. 0 when already full. */
  resetMs: number;
}

/** Thrown for invalid configs or costs, never for ordinary rate limiting. */
export class TokenBucketConfigError extends RangeError {
  override name = "TokenBucketConfigError";
}

export function validateConfig(config: BucketConfig): void {
  if (!(Number.isFinite(config.capacity) && config.capacity > 0)) {
    throw new TokenBucketConfigError(
      `capacity must be a finite number > 0, got ${String(config.capacity)}`,
    );
  }
  if (!(Number.isFinite(config.refillPerSecond) && config.refillPerSecond > 0)) {
    throw new TokenBucketConfigError(
      `refillPerSecond must be a finite number > 0, got ${String(config.refillPerSecond)}`,
    );
  }
}

/** A full bucket at `now`. */
export function fullBucket(config: BucketConfig, now: number): BucketState {
  return { tokens: config.capacity, updatedAt: now };
}

/**
 * Lazily refill `state` up to `now`. A clock that went backwards refills
 * nothing rather than draining, and tokens never exceed capacity.
 */
export function refill(
  state: BucketState,
  config: BucketConfig,
  now: number,
): BucketState {
  const elapsedMs = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(
    config.capacity,
    state.tokens + (elapsedMs / 1000) * config.refillPerSecond,
  );
  return { tokens, updatedAt: Math.max(now, state.updatedAt) };
}

/**
 * Refill is float arithmetic; three 10-second refills at 120/h should equal
 * one token, but sum to 0.9999…. Comparisons tolerate that.
 */
const EPSILON = 1e-9;

/** Ms until `tokens` reaches `target`, rounded up so a retry is never early. */
function msUntil(tokens: number, target: number, config: BucketConfig): number {
  if (tokens + EPSILON >= target) return 0;
  return Math.ceil(((target - tokens) / config.refillPerSecond) * 1000);
}

/**
 * Try to remove `cost` tokens at `now`. `state` may be `undefined` for a
 * bucket that has never been used (treated as full). Returns the new state
 * to persist alongside the result to report.
 */
export function take(
  state: BucketState | undefined,
  config: BucketConfig,
  cost: number,
  now: number,
): { state: BucketState; result: TakeResult } {
  validateConfig(config);
  if (!(Number.isFinite(cost) && cost >= 0)) {
    throw new TokenBucketConfigError(
      `cost must be a finite number >= 0, got ${String(cost)}`,
    );
  }
  if (cost > config.capacity) {
    throw new TokenBucketConfigError(
      `cost ${cost} exceeds capacity ${config.capacity}; it could never be allowed`,
    );
  }

  const refilled = refill(state ?? fullBucket(config, now), config, now);
  const allowed = refilled.tokens + EPSILON >= cost;
  const tokens = allowed ? Math.max(0, refilled.tokens - cost) : refilled.tokens;
  const next: BucketState = { tokens, updatedAt: refilled.updatedAt };

  return {
    state: next,
    result: {
      allowed,
      remaining: Math.floor(tokens + EPSILON),
      retryAfterMs: allowed ? 0 : msUntil(tokens, cost, config),
      resetMs: msUntil(tokens, config.capacity, config),
    },
  };
}
