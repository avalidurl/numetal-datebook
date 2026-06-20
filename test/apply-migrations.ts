import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply Drizzle-generated migrations to the isolated test D1 once; isolatedStorage
// gives each test a fresh copy of this seeded schema.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
