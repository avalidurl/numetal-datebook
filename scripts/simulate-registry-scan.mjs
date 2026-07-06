#!/usr/bin/env node
/**
 * Simulates x402scan register-origin auth routing against a live openapi.json.
 * Mirrors @agentcash/discovery inferAuthMode + register-origin SKIP/register rules.
 */
const ORIGIN = process.argv[2] ?? "https://api.ishtar.numetal.xyz";

function inferAuthMode(operation, globalSecurity, securitySchemes = {}) {
  const hasXPaymentInfo = Boolean(operation["x-payment-info"]);
  const operationOptsOutOfSecurity =
    Array.isArray(operation.security) && operation.security.length === 0;
  if (operationOptsOutOfSecurity && !hasXPaymentInfo) return "unprotected";

  const effectiveSecurity =
    operation.security !== undefined ? operation.security : globalSecurity ?? [];
  let hasApiKey = false;
  let hasSiwx = false;
  for (const requirement of effectiveSecurity) {
    for (const schemeName of Object.keys(requirement)) {
      if (schemeName === "siwx") hasSiwx = true;
      const def = securitySchemes[schemeName];
      if (def?.["x-agentcash-auth-kind"] === "siwx") hasSiwx = true;
      if (schemeName === "apiKey" || def?.type === "apiKey") hasApiKey = true;
    }
  }
  if (hasXPaymentInfo && hasApiKey) return "apiKey+paid";
  if (hasXPaymentInfo) return "paid";
  if (hasApiKey) return "apiKey";
  if (hasSiwx) return "siwx";
  return undefined;
}

function routeAction(authMode) {
  const SKIP = new Set(["apiKey"]);
  if (authMode && SKIP.has(authMode)) return "skipped";
  if (authMode === "siwx") return "register-siwx";
  if (authMode === "unprotected") return "register-public";
  if (authMode === "paid" || authMode === "apiKey+paid") return "probe-paid";
  return "probe-unclassified";
}

const specUrl = `${ORIGIN.replace(/\/$/, "")}/openapi.json`;
const spec = await fetch(specUrl).then((r) => {
  if (!r.ok) throw new Error(`fetch ${specUrl} → ${r.status}`);
  return r.json();
});

const schemes = spec.components?.securitySchemes ?? {};
const rows = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(item)) {
    if (!op || typeof op !== "object" || !("responses" in op)) continue;
    const authMode = inferAuthMode(op, spec.security, schemes);
    rows.push({
      method: method.toUpperCase(),
      path,
      authMode: authMode ?? "(unclassified)",
      action: routeAction(authMode),
      security: op.security,
      hasXPaymentInfo: Boolean(op["x-payment-info"]),
    });
  }
}

const focus = [
  "/api/floor",
  "/api/public/stats",
  "/api/heartbench",
  "/api/heartbench/scenarios",
  "/api/heartbench/scenarios/{id}",
  "/api/heartbench/view",
];

console.log(`OpenAPI: ${specUrl}`);
console.log(`Global security: ${JSON.stringify(spec.security ?? null)}`);
console.log("");
for (const p of focus) {
  const r = rows.find((x) => x.path === p);
  console.log(JSON.stringify(r, null, 2));
  console.log("");
}

const summary = rows.reduce((acc, r) => {
  acc[r.action] = (acc[r.action] ?? 0) + 1;
  return acc;
}, {});
console.log("Summary:", summary);
