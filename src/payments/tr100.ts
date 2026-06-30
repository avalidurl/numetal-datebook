/**
 * TR-100 receipt — a boxed monospace machine report for a paid Window slot. Shared by BOTH payment
 * paths (human/LlamaPay + agent/x402); the only divergence is the PAYMENT REF + processor line.
 *
 * Layout is after the TR-100 Machine Report by U.S. Graphics Co. (BSD-3-Clause © 2024) — attributed
 * in the footer per the licence. NO colour, NO emoji; box-drawing chars + a monospace stack only.
 *
 *  - Human (LlamaPay) path: PAYMENT REF = "llamapay:<id>", optionally linked to the hosted payment
 *    page. The webhook carries NO chain tx hash → we DO NOT print a basescan link for the human path.
 *  - Agent (x402) path: PAYMENT REF = the on-chain settle tx → https://basescan.org/tx/<hash>.
 */

export interface ReceiptInput {
  orderId: string; // our order id (e.g. "featured:human:<ref>")
  authorKind: "human" | "agent";
  handle?: string | null; // public-safe poster handle/ref (never PII)
  publicSummary: string; // the chaperoned public blurb
  amountUsd: string; // "50.00"
  paidAt: string; // ISO timestamp the payment confirmed
  windowFrom: string; // ISO — feature window open (paid-at)
  windowTo: string; // ISO — feature window close (+24h)
  slotOf: number; // N — this slot's ordinal today
  slotCap: number; // 10 — daily cap
  // Exactly ONE of these is set, by path:
  llamapayId?: string; // human path: LlamaPay payment id → "llamapay:<id>"
  llamapayHostedUrl?: string; // human path: optional link to the hosted payment page
  settlementTx?: string; // agent path: on-chain settle tx hash → basescan link
}

const ATTRIBUTION = "Receipt layout after the TR-100 Machine Report · U.S. Graphics Co. · BSD-3-Clause © 2024";

const esc = (s: string) =>
  String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] as string);

/** Compact a free-text blurb onto one receipt line (collapse whitespace, hard-cap length). */
const oneLine = (s: string, max = 58): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const utc = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

/** The report number, derived from the order id (the unique idempotency key). */
export function receiptReportNo(orderId: string): string {
  const tail = orderId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `TR-W-${tail}`;
}

/** The payment-ref string + an optional link target, by path. */
function paymentRef(i: ReceiptInput): { ref: string; href?: string } {
  if (i.authorKind === "agent" && i.settlementTx) {
    return { ref: i.settlementTx, href: `https://basescan.org/tx/${i.settlementTx}` };
  }
  if (i.llamapayId) {
    // Human/LlamaPay path: the webhook has NO chain tx hash → never a basescan link. Link to the
    // hosted payment page if we have it.
    return { ref: `llamapay:${i.llamapayId}`, href: i.llamapayHostedUrl };
  }
  return { ref: "—" };
}

function processorLine(i: ReceiptInput): string {
  // Human/LlamaPay → "LlamaPay"; agent/x402 → "Base · USDC" (the on-chain network it settles on).
  return i.authorKind === "agent" ? "Base · USDC" : "LlamaPay";
}

/**
 * Render the TR-100 receipt as a self-contained, boxed monospace HTML fragment (no color/emoji).
 * The site auto-downloads this and it is also emailed via resendSend. Both paths share the generator.
 */
export function renderTR100(i: ReceiptInput): string {
  const reportNo = receiptReportNo(i.orderId);
  const { ref, href } = paymentRef(i);
  const refCell = href
    ? `<a href="${esc(href)}" style="color:inherit;text-decoration:underline">${esc(ref)}</a>`
    : esc(ref);
  const rows: Array<[string, string]> = [
    ["REPORT NO.", esc(reportNo)],
    ["PAYMENT REF", refCell],
    ["PAID AT (UTC)", esc(utc(i.paidAt))],
    ["AMOUNT", `$${esc(i.amountUsd)} USD`],
    ["PROCESSOR/NETWORK", esc(processorLine(i))],
    ["FEATURE FROM", esc(utc(i.windowFrom))],
    ["FEATURE TO", esc(utc(i.windowTo))],
    ["SLOT", `${i.slotOf} of ${i.slotCap} today`],
    ["AUTHOR KIND", esc(i.authorKind)],
    ["HANDLE", esc(i.handle ?? "—")],
    ["PUBLIC SUMMARY", esc(oneLine(i.publicSummary))],
  ];
  const W = 64; // inner content width (chars), drives the box rules
  const top = "┌" + "─".repeat(W) + "┐";
  const mid = "├" + "─".repeat(W) + "┤";
  const bot = "└" + "─".repeat(W) + "┘";
  const pad = (s: string) => " " + s + " ".repeat(Math.max(0, W - 1 - s.length));
  // Title band.
  const title = pad("THE WINDOW — PAYMENT RECEIPT");
  const sub = pad("Ishtar · ishtar.numetal.xyz/window");
  // Field rows: "  LABEL ............ value" feel, but we keep it as label/value columns.
  const labelW = 18;
  const bodyRows = rows
    .map(([label, value]) => {
      const lab = (label + ":").padEnd(labelW);
      // value may contain HTML (the link) — measure on a stripped copy for padding only.
      const plain = value.replace(/<[^>]+>/g, "");
      const room = W - 1 - labelW - 1;
      const shownPlain = plain.length > room ? plain.slice(0, room) : plain;
      // If we had to truncate a *plain* value (no HTML), re-truncate the real value too.
      const realValue = plain === value && plain.length > room ? esc(shownPlain) : value;
      const padCount = Math.max(0, room - shownPlain.length);
      return `│ ${lab}${realValue}${" ".repeat(padCount)} │`;
    })
    .join("\n");
  const footer = pad(ATTRIBUTION.length > W - 2 ? ATTRIBUTION.slice(0, W - 3) + "…" : ATTRIBUTION);

  const ascii = [
    top,
    `│${title}│`,
    `│${sub}│`,
    mid,
    bodyRows,
    mid,
    `│${footer}│`,
    bot,
  ].join("\n");

  // The full attribution always appears as readable text below the box (so a clipped box line never
  // drops the licence credit), plus the boxed report itself.
  return `<div style="background:#fff;color:#000;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.35;padding:0;margin:0">
<pre style="margin:0;white-space:pre;font:inherit;color:#000">${ascii}</pre>
<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:#000;margin-top:6px">${esc(ATTRIBUTION)}</div>
</div>`;
}

/** Full standalone HTML document (for the email body + the auto-download blob). */
export function renderTR100Document(i: ReceiptInput): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(receiptReportNo(i.orderId))} — The Window receipt</title></head><body style="margin:0;background:#fff;padding:20px">${renderTR100(i)}</body></html>`;
}
