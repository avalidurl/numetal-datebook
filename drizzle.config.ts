import { defineConfig } from "drizzle-kit";

// Generate-only: emits plain SQLite migrations into src/db/migrations,
// applied to D1 via `wrangler d1 migrations apply datebook-staging`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
