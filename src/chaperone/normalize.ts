/**
 * Pre-classification normalization (chaperone hardening). 2024-26 research (Mindgard,
 * arXiv 2504.11168) shows safety classifiers like Llama-Guard are reliably bypassed by
 * emoji/variation-selector smuggling, zero-width characters, Unicode tags, and homoglyphs:
 * the guard strips them at tokenization and sees "safe", while the downstream model still
 * reads the live payload. So we deterministically clean text BEFORE the denylist + classifier,
 * classify the CLEANED text, and treat heavy invisible/confusable use as suspicious in itself.
 */

// Zero-width + BOM + word-joiner + soft-hyphen + variation selectors + Unicode TAG block (E0000-E007F).
const INVISIBLE = /[​-‍﻿⁠­᠎︀-️]|[\u{E0000}-\u{E007F}]/gu;

// Common Cyrillic/Greek homoglyphs → ASCII (covers the high-value lookalikes used to defeat
// keyword denylists, e.g. Cyrillic "tееn"). Not exhaustive; folds the frequent attack set.
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "ѕ": "s", "і": "i",
  "ј": "j", "ԁ": "d", "ո": "n", "г": "r", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Х": "X", "У": "Y", "І": "I", "В": "B",
  "К": "K", "М": "M", "Т": "T", "Н": "H", "Ѕ": "S",
  "α": "a", "ο": "o", "ρ": "p", "ϲ": "c", "ε": "e", "ι": "i", "ν": "v", "Ο": "O", "Α": "A",
};

export interface Normalized {
  clean: string;
  suspicious: boolean;
  reason?: string;
}

/** Strip invisibles, NFKC-fold, then map homoglyphs. Returns the cleaned text + a suspicion flag. */
export function normalizeForGuard(text: string): Normalized {
  const stripped = text.replace(INVISIBLE, "");
  const removed = [...text].length - [...stripped].length;
  const nfkc = stripped.normalize("NFKC");
  let folded = "";
  let homoglyphHits = 0;
  for (const ch of nfkc) {
    const f = HOMOGLYPHS[ch];
    if (f) {
      folded += f;
      homoglyphHits++;
    } else {
      folded += ch;
    }
  }
  const len = Math.max(1, [...text].length);
  // Heavy invisible-character use, or many confusables, is itself a strong evasion signal.
  let suspicious = false;
  let reason: string | undefined;
  if (removed > 4 || removed / len > 0.03) {
    suspicious = true;
    reason = `obfuscation: ${removed} invisible char(s)`;
  } else if (homoglyphHits > 4 || homoglyphHits / len > 0.15) {
    suspicious = true;
    reason = `obfuscation: ${homoglyphHits} confusable char(s)`;
  }
  return { clean: folded, suspicious, reason };
}
