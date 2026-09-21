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
// Used for long-form streamed chat text, where stripping LRM/RLM/ALM would
// break legitimate mixed-direction prose.
export const DANGEROUS_BIDI_CONTROL_PATTERN = /[‪-‮⁦-⁩]/g;

// The full Unicode Bidi_Control property: the two above PLUS U+061C (ALM),
// U+200E (LRM), and U+200F (RLM). Those three are individually weaker --
// they influence only adjacent characters rather than reordering a whole
// span -- but sanitizeTerminalText's callers are short, security-sensitive
// single-line fields (permission-request titles, tool names) with no
// legitimate use for any directional mark, so the full set is stripped
// here even though the streaming chat-text sanitizer keeps them.
const STRICT_BIDI_CONTROL_PATTERN = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Normalize untrusted text for single-line terminal/log rendering.
 */
export function sanitizeTerminalText(input: string): string {
  const normalized = stripAnsi(input)
    .replace(STRICT_BIDI_CONTROL_PATTERN, "")
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
