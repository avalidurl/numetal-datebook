import { describe, expect, it } from "vitest";
import { selectPriceUsd, smoothPrice } from "../src/economics/numetal";

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
