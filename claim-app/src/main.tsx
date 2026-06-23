import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";

// Bundled replacement for the old esm.sh runtime script. Drives the datasheet claim page's existing
// DOM (#signin button, #msg, #app mount) — the design/markup lives in claimShell (server-rendered),
// this only wires Privy. No login methods are restricted: the modal shows every method enabled in
// the Privy dashboard (email, SMS, all socials, wallet).
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
        const r = await fetch("/api/escalations/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN, privyToken }),
        });
        const j = (await r.json()) as { ok?: boolean; reason?: string; error?: string; diditUrl?: string };
        if (j.ok) {
          setMsg("Confirmed. A quick binding 18+ identity check is next…");
          if (j.diditUrl) location.href = j.diditUrl;
        } else {
          setMsg("Could not confirm: " + (j.reason || j.error || r.status), true);
        }
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
    // No embedded wallet — a human confirming a date only needs to authenticate. Forcing wallet
    // creation on login was hanging at "creating your wallet". External-wallet *login* still works;
    // this only disables auto-provisioning an embedded wallet.
    { appId: APP_ID, config: { embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } } } },
    React.createElement(Bridge),
  ),
);

// Watchdog: if Privy never readies (e.g. SDK fails to init), flip the button to a Reload action so
// the page is never a dead end.
setTimeout(() => {
  if (!settled && btn) {
    setMsg("Sign-in is taking too long — reload to retry.", true);
    btn.disabled = false;
    btn.textContent = "↻ Reload";
    btn.onclick = () => location.reload();
  }
}, 12000);
