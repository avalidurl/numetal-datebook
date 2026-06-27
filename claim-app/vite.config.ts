import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Bundles React + the full Privy SDK (all login methods + wallet connectors need Buffer/process/
// global polyfills) into ONE self-contained IIFE served by the worker at /claim.js. This replaces
// the old runtime esm.sh imports (slow + half-wired → no method completed). Output: dist/claim.js.
export default defineConfig({
  plugins: [react(), nodePolyfills()],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    target: "es2020",
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: "src/main.tsx",
      formats: ["iife"],
      name: "IshtarClaim",
      fileName: () => "claim.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
