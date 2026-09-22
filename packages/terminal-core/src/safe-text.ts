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

// Built from numeric code points, not literal characters or regex \u
// escapes embedded in a character class: this pattern exists to defend
// against exactly these characters reordering how text (and source code)
// visually renders, so the pattern's own source must stay auditable as
// plain hex numbers rather than risk hiding or being hidden by the same
// spoofing it's meant to catch.
function bidiControlPattern(codePoints: readonly number[]): RegExp {
  const chars = codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join("");
  return new RegExp(`[${chars}]`, "g");
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
const BIDI_OVERRIDE_AND_ISOLATE_CODEPOINTS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];
export const DANGEROUS_BIDI_CONTROL_PATTERN = bidiControlPattern(
  BIDI_OVERRIDE_AND_ISOLATE_CODEPOINTS,
);

// The full Unicode Bidi_Control property: the code points above PLUS
// U+061C (ALM), U+200E (LRM), and U+200F (RLM). Those three are
// individually weaker -- they influence only adjacent characters rather
// than reordering a whole span -- but sanitizeStrictSingleLineText's
// callers are short, security-sensitive single-line fields (ACP
// permission-prompt titles, tool names) with no legitimate use for any
// directional mark, so the full set is stripped there even though
// sanitizeTerminalText's much broader set of callers need the narrower
// pattern to avoid corrupting real prose.
const STRICT_BIDI_CODEPOINTS = [0x061c, 0x200e, 0x200f, ...BIDI_OVERRIDE_AND_ISOLATE_CODEPOINTS];
const STRICT_BIDI_CONTROL_PATTERN = bidiControlPattern(STRICT_BIDI_CODEPOINTS);

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
