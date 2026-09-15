import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // An error thrown inside a Durable Object RPC method reaches the caller
    // as a rejection *and* is reported by the object's isolate as uncaught.
    // The config-error test asserts the rejection; drop the duplicate report.
    onUnhandledError(error) {
      if (error.name === "TokenBucketConfigError") return false;
    },
  },
});
