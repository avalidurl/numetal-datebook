import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "src/db/migrations"));
  // The suite binds from wrangler.test.toml, so `env` cannot see production values. Ship the real
  // wrangler.toml in as text so test/model-policy.test.ts can assert on what PRODUCTION actually
  // runs (banned vendors, JUDGE_MODEL disjoint from MODEL_POOL) rather than on the test mirror.
  const prodWranglerToml = await readFile(path.join(__dirname, "wrangler.toml"), "utf8");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          // Test config drops AI/Vectorize bindings (unavailable in the bundled runtime).
          wrangler: { configPath: "./wrangler.test.toml" },
          miniflare: {
            compatibilityDate: "2025-02-04",
            compatibilityFlags: ["nodejs_compat"],
            // Explicit, deterministic test env — overrides any .dev.vars the pool auto-loads
            // (otherwise real ACCESS_KEY / DIDIT values leak in and break the suite).
            bindings: {
              TEST_MIGRATIONS: migrations,
              PROD_WRANGLER_TOML: prodWranglerToml,
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
        },
      },
    },
  };
});
