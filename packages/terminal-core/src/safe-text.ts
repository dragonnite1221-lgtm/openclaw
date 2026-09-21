// Terminal Core module implements safe text behavior.
import { stripAnsi } from "./ansi.js";

/** Return whether text contains C0 or C1 terminal control characters. */
export function hasTerminalControl(input: string): boolean {
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

// U+202A-U+202E (embeddings/overrides) and U+2066-U+2069 (isolates): the
// bidi controls capable of reordering how SUBSEQUENT text visually renders
// regardless of byte order (the "Trojan Source"-style spoofing vector).
// Deliberately narrower than the full Unicode Format category: legitimate
// text uses ZWJ/ZWNJ (U+200D/U+200C) for emoji sequences and complex script
// shaping, and simple direction marks (U+200E/U+200F) for ordinary
// mixed-direction prose, none of which reorder anything beyond themselves.
export const DANGEROUS_BIDI_CONTROL_PATTERN = /[‪-‮⁦-⁩]/g;

/**
 * Normalize untrusted text for single-line terminal/log rendering.
 */
export function sanitizeTerminalText(input: string): string {
  const normalized = stripAnsi(input)
    .replace(DANGEROUS_BIDI_CONTROL_PATTERN, "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  let sanitized = "";
  for (const char of normalized) {
    if (!hasTerminalControl(char)) {
      sanitized += char;
    }
  }
  return sanitized;
}
