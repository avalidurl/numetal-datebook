// Founder-run mainnet x402 acceptance test for Ishtar `/api/chat/topup` — the canonical x402 **v2** client.
//
// WHAT IT PROVES: a real $1 USDC payment on Base settles through Ishtar's CDP verify→settle adapter to the
// configured PAY_TO (a wallet you control). This is the only true end-to-end proof; it MOVES $1 of real USDC, so it
// is run by you (the operator cannot move funds). It was money-safely pre-verified: a v2 client signs a valid
// EIP-3009 authorization our server + CDP accept, and an eth_call simulation of the transfer succeeds.
//
// WHY v2: Ishtar speaks x402 **v2** (CAIP-2 networks, header transport: PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
// PAYMENT-RESPONSE), matching the CDP facilitator. The old unscoped `x402-fetch` (v1) cannot pay it.
//
// SETUP (one time):
//   cd ~/GitHub/gokhan-vc/numetal-datebook
//   pnpm add @x402/fetch @x402/evm viem    # already installed in this repo
// RUN (defaults to the funded based-bot wallet we control; override with TEST_PRIVATE_KEY for another wallet):
//   node scripts/founder-x402-test.mjs
//   # the payer must hold >= ~$1 USDC on Base and MUST differ from the configured PAY_TO.
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import fs from "node:fs";
import os from "node:os";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NEED = 1_000_000n; // $1.00 at 6dp (chat_topup price)

let PK = process.env.TEST_PRIVATE_KEY;
if (!PK) {
  // default: the funded based-bot wallet whose key we control (in agent-secrets)
  const f = os.homedir() + "/.config/agent-secrets/based-bot/.env";
  const m = fs.existsSync(f) ? fs.readFileSync(f, "utf8").match(/^PK=(.+)$/m) : null;
  PK = m ? m[1].trim().replace(/^"|"$/g, "") : null;
}
if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK)) {
  console.error("No key. Set TEST_PRIVATE_KEY=0x<64hex> (a funded Base wallet, NOT the PAY_TO address).");
  process.exit(1);
}

const signer = privateKeyToAccount(PK);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Pre-check the payer's USDC balance — a shortfall reverts on-chain as "exceeds balance" and surfaces
// only as an opaque "cdp verify 400", so fail fast with a clear message instead.
const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const bal = await pub.readContract({
  address: USDC_BASE,
  abi: [{ inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }],
  functionName: "balanceOf",
  args: [signer.address],
});
console.log(`Payer ${signer.address}  USDC: ${(Number(bal) / 1e6).toFixed(6)}  (need ≥ 1.000000)`);
if (bal < NEED) {
  console.error(`❌ Insufficient USDC. Send ≥ $1 USDC (Base) to ${signer.address}, then re-run. No request sent.`);
  process.exit(1);
}

const url = "https://api.ishtar.numetal.xyz/api/chat/topup";
const ref = "founder-mainnet-test-" + Date.now();

// Read the configured PAY_TO from the live challenge so we report exactly where the $1 lands.
let payTo = "(the configured PAY_TO)";
try {
  const chal = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, over18: true }) });
  const pr = JSON.parse(Buffer.from(chal.headers.get("payment-required") || "", "base64").toString("utf8"));
  payTo = pr?.accepts?.[0]?.payTo || payTo;
} catch {
  /* fall back to the generic label */
}
console.log(`Paying $1 USDC from ${signer.address} → PAY_TO ${payTo}  ref: ${ref}`);

try {
  const res = await fetchWithPay(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, over18: true }),
  });
  const body = await res.json().catch(() => ({}));
  console.log("HTTP", res.status);
  console.log(JSON.stringify(body, null, 2));
  if (res.status === 200 && body.ok) {
    console.log(`\n✅ SETTLED — mainnet x402 v2 PROVEN.  credited=${body.credited}  creditsBalance=${body.creditsBalance ?? body.balance ?? "?"}`);
    console.log(`On-chain: a 1.000000 USDC transfer from your wallet → ${payTo} on Base.`);
  } else {
    console.log("\n⚠️ Not settled — status/body above.");
  }
} catch (e) {
  console.error("\n❌ Threw:", e?.message || e);
  if (e?.cause) console.error("cause:", JSON.stringify(e.cause).slice(0, 600));
  process.exit(1);
}
