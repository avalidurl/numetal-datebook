/**
 * Workers AI cost table — USD per 1,000,000 tokens. Live-verified 2026-06 from
 * developers.cloudflare.com/workers-ai. Used to fill the inference_costs ledger
 * and enforce dollar budgets. Re-verify at deploy.
 */
export interface ModelPrice {
  inPerM: number;
  outPerM: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  "@cf/meta/llama-guard-3-8b": { inPerM: 0.484, outPerM: 0.03 },
  "@cf/baai/bge-m3": { inPerM: 0.012, outPerM: 0 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 0.293, outPerM: 2.253 },
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": { inPerM: 0.497, outPerM: 4.881 },
  "@cf/qwen/qwq-32b": { inPerM: 0.66, outPerM: 1.0 },
  "@cf/qwen/qwen2.5-coder-32b-instruct": { inPerM: 0.66, outPerM: 1.0 },
  "@cf/openai/gpt-oss-120b": { inPerM: 0.35, outPerM: 0.75 },
  "@cf/openai/gpt-oss-20b": { inPerM: 0.2, outPerM: 0.3 },
  "@cf/meta/llama-3.1-8b-instruct-fast": { inPerM: 0.045, outPerM: 0.384 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { inPerM: 0.27, outPerM: 0.85 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { inPerM: 0.35, outPerM: 0.55 },
};

const DEFAULT_PRICE: ModelPrice = { inPerM: 0.3, outPerM: 2.5 }; // conservative fallback

const CHARS_PER_TOKEN = 4;
const estTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

/** Extract (tokensIn, tokensOut) from a Workers AI result + the inputs, with estimation fallback. */
export function tokensOf(result: unknown, promptText: string): { tokensIn: number; tokensOut: number } {
  const usage = (result as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
    return { tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens };
  }
  const out =
    typeof (result as { response?: string })?.response === "string"
      ? (result as { response: string }).response
      : JSON.stringify(result ?? "");
  return { tokensIn: estTokens(promptText), tokensOut: estTokens(out) };
}

/** USD cost for a call. */
export function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICING[model] ?? DEFAULT_PRICE;
  return (tokensIn / 1e6) * p.inPerM + (tokensOut / 1e6) * p.outPerM;
}
