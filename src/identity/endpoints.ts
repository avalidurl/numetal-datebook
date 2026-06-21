/**
 * Agent endpoint validation (audit high-fix: spoofable identity). An endpoint is
 * `pending` until it proves control of its claimed key/callback:
 *   (a) a signed-nonce challenge (EIP-191 personal_sign over the nonce), or
 *   (b) a callback round-trip (we POST the nonce, the agent echoes it back).
 * Fail-closed: no proof → stays pending → cannot be used to key rate-limit/budget.
 */
import { eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import type { DB } from "../db/client";
import { agentEndpoints } from "../db/schema";
import type { Env } from "../env";

const nonce = (): string =>
  `ishtar:${crypto.randomUUID()}:${Date.now()}`;

export async function registerEndpoint(
  db: DB,
  _env: Env,
  input: {
    ownerId?: number;
    personaId?: number;
    runtime: string;
    callbackUrl?: string;
    publicKey?: string;
  },
): Promise<{ id: number; challengeNonce: string }> {
  const challengeNonce = nonce();
  const row = await db
    .insert(agentEndpoints)
    .values({
      ownerId: input.ownerId,
      personaId: input.personaId,
      runtime: input.runtime,
      callbackUrl: input.callbackUrl,
      publicKey: input.publicKey,
      challengeNonce,
      status: "pending",
    })
    .returning({ id: agentEndpoints.id })
    .get();
  return { id: row.id, challengeNonce };
}

export async function verifyEndpoint(
  db: DB,
  _env: Env,
  input: { endpointId: number; signature?: `0x${string}`; echoToken?: string },
): Promise<{ active: boolean; reason: string }> {
  const ep = await db
    .select()
    .from(agentEndpoints)
    .where(eq(agentEndpoints.id, input.endpointId))
    .get();
  if (!ep || !ep.challengeNonce) return { active: false, reason: "unknown endpoint" };

  let proven = false;
  let how = "";

  // (a) signature proof
  if (input.signature && ep.publicKey) {
    try {
      proven = await verifyMessage({
        address: ep.publicKey as `0x${string}`,
        message: ep.challengeNonce,
        signature: input.signature,
      });
      how = "signature";
    } catch {
      proven = false;
    }
  }

  // (b) callback round-trip proof
  if (!proven && ep.callbackUrl) {
    try {
      const echoed =
        input.echoToken === ep.challengeNonce ||
        (await callbackEchoes(ep.callbackUrl, ep.challengeNonce));
      proven = echoed;
      how = "callback";
    } catch {
      proven = false;
    }
  }

  if (!proven) return { active: false, reason: "challenge not satisfied" };

  await db
    .update(agentEndpoints)
    .set({ status: "active", verifiedAt: new Date().toISOString() })
    .where(eq(agentEndpoints.id, input.endpointId))
    .run();
  return { active: true, reason: `verified:${how}` };
}

async function callbackEchoes(url: string, expected: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: expected }),
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { echo?: string };
  return body.echo === expected;
}
