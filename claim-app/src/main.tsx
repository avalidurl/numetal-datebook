import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";

// Bundled claim flow (served as /claim.js via Workers Assets). Drives the datasheet claim page's DOM:
// #signin (login button), #msg (status line), #app (hidden Privy mount). Flow: Privy login (any
// method) → POST /api/escalations/claim (profile_claimed + starts a Didit session server-side) →
// redirect the human straight into Didit's hosted 18+/ID check. Didit's signed webhook promotes the
// owner on approval. NO third-party age widget is mounted here — Didit hosts the check.
const APP_ID = (window as unknown as { __PRIVY_APP_ID__?: string }).__PRIVY_APP_ID__ || "";
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const btn = document.getElementById("signin") as HTMLButtonElement | null;
const setMsg = (t: string, bad?: boolean) => {
  const m = document.getElementById("msg");
  if (m) {
    m.textContent = t;
    (m as HTMLElement).style.color = bad ? "var(--red,#e11d48)" : "var(--mut,#888)";
  }
};
const postJSON = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
};

let settled = false;

function Bridge() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  useEffect(() => {
    if (!ready || !btn) return;
    if (!authenticated) {
      settled = true;
      btn.disabled = false;
      setMsg("Sign in to confirm the introduction.");
      btn.onclick = () => login();
      return;
    }
    settled = true;
    btn.disabled = true;
    (async () => {
      setMsg("Confirming…");
      try {
        const privyToken = await getAccessToken();
        const claim = await postJSON("/api/escalations/claim", { token: TOKEN, privyToken });
        const alreadyClaimed = !claim.ok && /used invite/i.test(String(claim.error || ""));
        if (!claim.ok && !alreadyClaimed) {
          setMsg("Could not confirm: " + (claim.reason || claim.error), true);
          return;
        }
        // Redirect into Didit's hosted 18+ / ID verification. Didit returns the result to our webhook.
        if (claim.ok && claim.diditUrl) {
          setMsg("One quick step — opening your secure 18+ verification…");
          location.href = String(claim.diditUrl);
          return;
        }
        // Didit not configured yet, or a re-entrant reload after the invite was consumed — never a
        // dead end: confirm gracefully and let the human continue in the verification window.
        setMsg("✓ Confirmed. Your 18+ verification step will open in a moment — if it doesn't, reload this link.");
        if (btn) { btn.disabled = true; btn.textContent = "✓ Confirmed"; }
      } catch (e) {
        setMsg("Error: " + (e as Error).message, true);
      }
    })();
  }, [ready, authenticated]);
  return null;
}

const mount = document.getElementById("app") || document.body;
createRoot(mount).render(
  React.createElement(
    PrivyProvider,
    { appId: APP_ID, config: { embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } } } },
    React.createElement(Bridge),
  ),
);

// Watchdog: never a blank dead end if Privy fails to init.
setTimeout(() => {
  if (!settled && btn) {
    setMsg("Sign-in is taking too long — reload to retry.", true);
    btn.disabled = false;
    btn.textContent = "↻ Reload";
    btn.onclick = () => location.reload();
  }
}, 12000);
