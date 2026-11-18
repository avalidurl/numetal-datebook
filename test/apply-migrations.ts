import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply Drizzle-generated migrations once per test file. Vitest 4 isolates storage
// per file, not per test, so later tests in the same file see earlier writes.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
