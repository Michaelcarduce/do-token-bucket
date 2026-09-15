import { DurableObject } from "cloudflare:workers";
import { take, type BucketConfig, type BucketState, type TakeResult } from "./bucket.js";

const STATE_KEY = "state";

/**
 * One token bucket per Durable Object instance. Address it with
 * `idFromName("<client>:<resource>")` and every request for that pair is
 * serialised through this single object, so there is no read-modify-write
 * race — the reason a DO is used here instead of KV.
 *
 * Config travels with each call rather than living in storage: the Worker
 * already knows the policy for the route, and it keeps the object stateless
 * apart from `{ tokens, updatedAt }`.
 *
 * SQLite-backed (`new_sqlite_classes` in wrangler.jsonc), so it runs on the
 * Workers free plan. An alarm wipes the state once the bucket is full again;
 * a full bucket is indistinguishable from a fresh one, so idle keys cost
 * nothing to keep.
 */
export class TokenBucket extends DurableObject {
  /**
   * Remove `cost` tokens (default 1). Never throws for ordinary limiting;
   * throws `TokenBucketConfigError` for an impossible config or cost.
   */
  async take(config: BucketConfig, cost = 1): Promise<TakeResult> {
    const now = Date.now();
    const previous = await this.ctx.storage.get<BucketState>(STATE_KEY);
    const { state, result } = take(previous, config, cost, now);

    if (result.resetMs > 0) {
      await this.ctx.storage.put(STATE_KEY, state);
      await this.ctx.storage.setAlarm(now + result.resetMs);
    } else {
      // Full bucket: same as no bucket. Don't keep a row for it.
      await this.ctx.storage.deleteAll();
    }
    return result;
  }

  /** Current tokens without spending any. */
  async peek(config: BucketConfig): Promise<TakeResult> {
    const previous = await this.ctx.storage.get<BucketState>(STATE_KEY);
    return take(previous, config, 0, Date.now()).result;
  }

  /** Forget this bucket entirely; the next `take` starts full. */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Fires when the bucket has refilled to capacity: nothing left to remember. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
