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
// This is sanitizeTerminalText's pattern: that function is shared by many
// callers that render arbitrary prose (CLI messages, transcript utterances),
// where stripping LRM/RLM/ALM would corrupt legitimate mixed-direction text.
export const DANGEROUS_BIDI_CONTROL_PATTERN = /[‪-‮⁦-⁩]/g;

// The full Unicode Bidi_Control property: the pattern above PLUS U+061C
// (ALM), U+200E (LRM), and U+200F (RLM). Those three are individually
// weaker -- they influence only adjacent characters rather than reordering
// a whole span -- but sanitizeStrictSingleLineText's callers are short,
// security-sensitive single-line fields (ACP permission-prompt titles, tool
// names) with no legitimate use for any directional mark, so the full set
// is stripped there even though sanitizeTerminalText's much broader set of
// callers need the narrower pattern to avoid corrupting real prose.
const STRICT_BIDI_CONTROL_PATTERN = /[؜‎‏‪-‮⁦-⁩]/g;

function sanitizeSingleLineText(input: string, bidiPattern: RegExp): string {
  const normalized = stripAnsi(input)
    .replace(bidiPattern, "")
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

/**
 * Normalize untrusted text for single-line terminal/log rendering. Shared
 * by many call sites, including ones that render arbitrary user-facing
 * prose -- keeps the narrower override/isolate bidi pattern so legitimate
 * mixed-direction text isn't corrupted. See sanitizeStrictSingleLineText
 * for short, security-sensitive fields that need the stricter pattern.
 */
export function sanitizeTerminalText(input: string): string {
  return sanitizeSingleLineText(input, DANGEROUS_BIDI_CONTROL_PATTERN);
}

/**
 * Stricter variant of sanitizeTerminalText for short, security-sensitive
 * single-line fields (ACP permission-prompt titles, tool names) where
 * there is no legitimate need for any directional mark and the stakes of a
 * spoofed rendering are high. Must NOT be used for rendering arbitrary
 * prose -- use sanitizeTerminalText there instead.
 */
export function sanitizeStrictSingleLineText(input: string): string {
  return sanitizeSingleLineText(input, STRICT_BIDI_CONTROL_PATTERN);
}
