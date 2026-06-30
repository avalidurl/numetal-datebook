import { describe, expect, it } from "vitest";
import { NUMETAL_SWAP_URL, numetalBuyQuote, selectPriceUsd, smoothPrice } from "../src/economics/numetal";

// The $NUMETAL/USD oracle that gates the paid human floor. Both aggregators read the same on-chain pool,
// so the manipulation defense is NOT "more sources" — it's the liquidity floor + median + the one-sided
// (rise-capped) smoothing. These pure tests lock that logic.
describe("$NUMETAL price oracle — selection (liquidity floor + median)", () => {
  it("returns 0 when there is nothing trustworthy", () => {
    expect(selectPriceUsd([])).toBe(0);
    expect(selectPriceUsd([{ source: "x", price: 0 }, { source: "y", price: -1 }])).toBe(0);
  });

  it("drops a sub-floor-liquidity (junk thin-pool) quote", () => {
    // a manipulated thin pool reads $5 but only $50 of liquidity → ignored; the deep pool's $1 wins.
    const p = selectPriceUsd(
      [
        { source: "thin", price: 5, liquidityUsd: 50 },
        { source: "deep", price: 1, liquidityUsd: 250_000 },
      ],
      { minLiquidityUsd: 500 },
    );
    expect(p).toBe(1);
  });

  it("takes the median of valid quotes (a single outlier can't swing it)", () => {
    expect(selectPriceUsd([{ source: "a", price: 1 }, { source: "b", price: 1.1 }, { source: "c", price: 9 }])).toBe(1.1);
  });

  it("keeps a quote with unknown liquidity (no field) rather than dropping it", () => {
    expect(selectPriceUsd([{ source: "gt", price: 2 }])).toBe(2);
  });
});

describe("$NUMETAL price oracle — one-sided smoothing (anti pump-to-pass)", () => {
  it("adopts the first observation as-is", () => {
    expect(smoothPrice(0, 1.5)).toBe(1.5);
  });

  it("keeps the last good price when all sources fail", () => {
    expect(smoothPrice(2, 0)).toBe(2);
    expect(smoothPrice(0, 0)).toBe(0); // no prior + no fresh → 0 (gate fails closed)
  });

  it("lets the price FALL immediately (conservative for a gate)", () => {
    expect(smoothPrice(2, 1)).toBe(1);
  });

  it("lets a small honest RISE through", () => {
    expect(smoothPrice(2, 2.2, 0.15)).toBeCloseTo(2.2); // +10% ≤ cap
  });

  it("CAPS a pump: a momentary 5x spike can only raise the stored price by maxUp", () => {
    // attacker pumps the pool 5x ($2 → $10) to clear the gate cheaply; the stored price rises ≤15%.
    expect(smoothPrice(2, 10, 0.15)).toBeCloseTo(2.3);
  });
});

describe("$NUMETAL buy quote (the human BUY button)", () => {
  it("computes the token amount + USDC to swap to reach the $50 floor from $0", () => {
    const q = numetalBuyQuote(0.001, 0, 50);
    expect(q.shortfallUsd).toBe(50);
    expect(q.usdcToSwap).toBe(50);
    expect(q.numetalNeeded).toBe(50000); // ceil(50 / 0.001)
    expect(q.buyUrl).toContain("amount=50");
    expect(q.buyUrl).toContain("0x57edb7fc54ada9ef4e113dc05a168449e63cfba3"); // → $NUMETAL
    expect(q.buyUrl).toContain("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // from USDC
  });

  it("only quotes the SHORTFALL when the wallet already holds some", () => {
    const q = numetalBuyQuote(0.001, 30, 50);
    expect(q.shortfallUsd).toBe(20);
    expect(q.numetalNeeded).toBe(20000);
  });

  it("returns zero-to-buy (no amount in the url) once at/above the floor", () => {
    const q = numetalBuyQuote(0.001, 60, 50);
    expect(q.shortfallUsd).toBe(0);
    expect(q.numetalNeeded).toBe(0);
    expect(q.buyUrl).toBe(NUMETAL_SWAP_URL);
  });

  it("no price (oracle dark) → still shows the USDC shortfall, 0 token estimate", () => {
    const q = numetalBuyQuote(0, 0, 50);
    expect(q.usdcToSwap).toBe(50);
    expect(q.numetalNeeded).toBe(0);
  });
});
