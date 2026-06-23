import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import Relay from "@persona/relay";

// Bundled claim flow (served as /claim.js via Workers Assets). Drives the datasheet claim page's
// existing DOM: #signin (login button), #msg (status line), #relay-container (age widget mount),
// #app (hidden Privy mount). Flow: Privy login (any method) → confirm the intro → privacy-preserving
// 18+ check via the Persona Relay widget → on pass, the human is identity_verified and unlocked.
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
let getToken: (() => Promise<string | null>) | null = null;

// Render the Persona Relay 18+ widget; on completion, redeem the claim server-side. No PII ever
// reaches this page — the widget surfaces only a completion signal; the pass/fail result is fetched
// by our server via the relay token.
function startAgeWidget(accessToken: string) {
  setMsg("One quick step — confirm you're 18 or older to unlock the introduction.");
  if (btn) btn.style.display = "none";
  const relay = new Relay("#relay-container", {
    accessToken,
    onComplete: async () => {
      setMsg("Verifying…");
      try {
        const privyToken = getToken ? await getToken() : null;
        const res = await postJSON("/api/age/claim", { privyToken });
        if (res.ok && res.result === "passed") setMsg("✓ Verified. Your introduction is unlocked — we'll connect you shortly.");
        else if (res.ok) setMsg("That didn't meet the 18+ requirement. This venue is adults-only.", true);
        else setMsg("Couldn't complete the check: " + (res.reason || res.error || "please try again"), true);
      } catch (e) {
        setMsg("Error finishing the check: " + (e as Error).message, true);
      }
      try { relay.destroy(); } catch { /* already gone */ }
    },
    onExpire: () => { setMsg("The check timed out — restarting…"); setTimeout(() => location.reload(), 1200); },
    onError: (err) => { console.error(err); setMsg("Verification error — reload to try again.", true); },
  });
}

function Bridge() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  useEffect(() => {
    if (!ready || !btn) return;
    getToken = getAccessToken;
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
        // Re-entrant: a reload after a successful claim returns "used invite" — that's fine, the owner
        // is already profile_claimed and the age step maps to them via the Privy login.
        const alreadyClaimed = !claim.ok && /used invite/i.test(String(claim.error || ""));
        if (!claim.ok && !alreadyClaimed) {
          setMsg("Could not confirm: " + (claim.reason || claim.error), true);
          return;
        }
        const sess = await postJSON("/api/age/session", { privyToken: await getAccessToken() });
        if (sess.ok && sess.accessToken) {
          startAgeWidget(String(sess.accessToken));
        } else {
          // Age provider not active yet (Relay access pending) — confirm gracefully, never a dead end.
          setMsg("✓ Confirmed. Your introduction is locked in — we'll send your 18+ verification step shortly.");
          if (btn) { btn.disabled = true; btn.textContent = "✓ Confirmed"; }
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
