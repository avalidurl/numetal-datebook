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
  llamapayId?: string; // human path: LlamaPay payment id → "llamapay:<id>" (INTERNAL — never in a public/status receipt)
  llamapayHostedUrl?: string; // human path: link to the hosted payment page (the public-safe payment URL)
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
  // Human/LlamaPay path: the webhook has NO chain tx hash → never a basescan link. The PUBLIC/status
  // receipt must NOT expose the internal payment id (IDOR — finding #2): when we have the LlamaPay
  // hosted payment URL, show THAT (public-safe) as the ref. The raw "llamapay:<id>" text is only ever
  // rendered when an internal caller explicitly passes llamapayId WITHOUT a hosted URL.
  if (i.llamapayHostedUrl) {
    return { ref: i.llamapayHostedUrl, href: i.llamapayHostedUrl };
  }
  if (i.llamapayId) {
    return { ref: `llamapay:${i.llamapayId}`, href: undefined };
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
  // Rows carry RAW (un-escaped) text plus an optional href. The body builder truncates the RAW text
  // FIRST, then esc()s exactly ONCE (finding #9 — never esc an already-escaped slice), and for a link
  // cell rebuilds the <a> with the truncated escaped text as inner content while keeping the FULL href
  // (finding #8). Padding is computed from the truncated VISIBLE length so every body line is W wide.
  type Row = { label: string; value: string; href?: string };
  const rows: Row[] = [
    { label: "REPORT NO.", value: reportNo },
    { label: "PAYMENT REF", value: ref, href },
    { label: "PAID AT (UTC)", value: utc(i.paidAt) },
    { label: "AMOUNT", value: `$${i.amountUsd} USD` },
    { label: "PROCESSOR/NETWORK", value: processorLine(i) },
    { label: "FEATURE FROM", value: utc(i.windowFrom) },
    { label: "FEATURE TO", value: utc(i.windowTo) },
    { label: "SLOT", value: `${i.slotOf} of ${i.slotCap} today` },
    { label: "AUTHOR KIND", value: i.authorKind },
    { label: "HANDLE", value: i.handle ?? "—" },
    { label: "PUBLIC SUMMARY", value: oneLine(i.publicSummary) },
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
  const room = W - 1 - labelW - 1; // visible chars available for the value cell
  // Any ref that didn't fit in the box is reprinted in full as plaintext below (so a truncated link
  // never hides the real payment pointer). Collected here, emitted after the box.
  const overflowNotes: string[] = [];
  const bodyRows = rows
    .map(({ label, value, href: rowHref }) => {
      const lab = (label + ":").padEnd(labelW);
      // 1) Truncate the RAW value to `room` (with an ellipsis when clipped) — measured on visible chars.
      const clipped = value.length > room;
      const shown = clipped ? value.slice(0, Math.max(0, room - 1)) + "…" : value;
      // 2) Escape EXACTLY once.
      const shownEsc = esc(shown);
      // 3) For a link cell, rebuild the <a> with the truncated escaped text but the FULL href.
      const cell = rowHref
        ? `<a href="${esc(rowHref)}" style="color:inherit;text-decoration:underline">${shownEsc}</a>`
        : shownEsc;
      // 4) Pad based on the TRUNCATED visible length so the right border always aligns.
      const padCount = Math.max(0, room - shown.length);
      if (clipped && rowHref) overflowNotes.push(`${label}: ${value}`); // full ref reprinted below the box
      return `│ ${lab}${cell}${" ".repeat(padCount)} │`;
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

  // Any clipped link ref is reprinted IN FULL as plaintext below the box (finding #8) so a truncated
  // box cell never hides the real payment pointer. esc() once.
  const overflowBlock = overflowNotes.length
    ? `\n<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:#000;margin-top:6px;word-break:break-all">${overflowNotes
        .map((n) => esc(n))
        .join("<br>")}</div>`
    : "";

  // The full attribution always appears as readable text below the box (so a clipped box line never
  // drops the licence credit), plus the boxed report itself.
  return `<div style="background:#fff;color:#000;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.35;padding:0;margin:0">
<pre style="margin:0;white-space:pre;font:inherit;color:#000">${ascii}</pre>${overflowBlock}
<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:#000;margin-top:6px">${esc(ATTRIBUTION)}</div>
</div>`;
}

/** Full standalone HTML document (for the email body + the auto-download blob). */
export function renderTR100Document(i: ReceiptInput): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(receiptReportNo(i.orderId))} — The Window receipt</title></head><body style="margin:0;background:#fff;padding:20px">${renderTR100(i)}</body></html>`;
}
