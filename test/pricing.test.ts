import { describe, expect, it } from "vitest";
import { costUsd } from "../src/economics/pricing";

describe("inference pricing", () => {
  it("a reasoning model's output dwarfs the guard's (why max_tokens + per-model caps matter)", () => {
    const guardOut = costUsd("@cf/meta/llama-guard-3-8b", 0, 1_000_000);
    const deepseekOut = costUsd("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", 0, 1_000_000);
    expect(deepseekOut).toBeGreaterThan(guardOut * 100);
  });

  it("falls back to a conservative non-zero price for unknown models", () => {
    expect(costUsd("@cf/unknown/model", 0, 1_000_000)).toBeGreaterThan(0);
  });
});
