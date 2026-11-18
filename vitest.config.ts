import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./src/db/migrations", import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        // Test config drops AI/Vectorize bindings (unavailable in the bundled runtime).
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          compatibilityDate: "2025-02-04",
          compatibilityFlags: ["nodejs_compat"],
          // Explicit, deterministic test env — overrides any .dev.vars the pool auto-loads
          // (otherwise real ACCESS_KEY / DIDIT values leak in and break the suite).
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_KEY: "test-key",
            FUZZ_INGEST_TOKEN: "test-fuzz-token",
            PAY_TO: "0xtestpayto",
            X402_MODE: "staging",
            DIDIT_API_KEY: "",
            DIDIT_WORKFLOW_ID: "",
            DIDIT_WEBHOOK_SECRET: "",
            PRIVY_APP_ID: "",
            PRIVY_VERIFICATION_KEY: "",
            SENTRY_DSN: "",
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_AUD: "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
