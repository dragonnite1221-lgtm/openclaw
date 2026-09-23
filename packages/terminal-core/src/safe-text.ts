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

// U+202A-U+202E: embeddings and overrides (LRE/RLE/PDF/LRO/RLO). These are
// the bidi controls capable of reordering how an UNBOUNDED span of
// SUBSEQUENT text visually renders regardless of byte order -- the classic
// "Trojan Source"-style spoofing vector, since a push has no required
// terminator and its effect extends until a matching pop or the end of
// the paragraph. Deliberately excludes isolates (U+2066-U+2069): those are
// explicitly bounded by their own PDI (or paragraph end) and only affect
// the directionality of the isolated span itself, not what follows it --
// the Unicode-recommended way to embed a phone number or foreign name
// inside otherwise RTL prose. This is sanitizeTerminalText's pattern: that
// function is shared by many callers that render arbitrary prose (CLI
// messages, transcript utterances), where stripping isolates or LRM/RLM/ALM
// would corrupt legitimate mixed-direction text.
const BIDI_OVERRIDE_CODEPOINTS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e];
export const DANGEROUS_BIDI_CONTROL_PATTERN = bidiControlPattern(BIDI_OVERRIDE_CODEPOINTS);

// The full Unicode Bidi_Control property: the overrides above PLUS U+061C
// (ALM), U+200E (LRM), U+200F (RLM), and U+2066-U+2069 (isolates). Even
// though isolates and the mark characters are individually weaker or
// self-bounded, sanitizeStrictSingleLineText's callers are short,
// security-sensitive single-line fields (ACP permission-prompt titles,
// tool names) with no legitimate use for any directional mark, so the
// full set is stripped there even though sanitizeTerminalText's much
// broader set of callers need the narrower pattern to avoid corrupting
// real prose.
const STRICT_BIDI_CODEPOINTS = [
  0x061c,
  0x200e,
  0x200f,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  ...BIDI_OVERRIDE_CODEPOINTS,
];
const STRICT_BIDI_CONTROL_PATTERN = bidiControlPattern(STRICT_BIDI_CODEPOINTS);

// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are Unicode's
// own official line-breaking characters -- many renderers (including some
// terminals) treat them as real line breaks even though they aren't \n or
// \r. A field claiming to be single-line must escape these the same way
// it escapes \n, \r, and \t, or a "single-line" security-sensitive field
// (a permission-prompt title, a tool name) could still be made to render
// as more than one line.
const LINE_SEPARATOR_PATTERN = new RegExp(String.fromCodePoint(0x2028), "g");
const PARAGRAPH_SEPARATOR_PATTERN = new RegExp(String.fromCodePoint(0x2029), "g");

function sanitizeSingleLineText(input: string, bidiPattern: RegExp): string {
  const normalized = stripAnsi(input)
    .replace(bidiPattern, "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(LINE_SEPARATOR_PATTERN, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR_PATTERN, "\\u2029");
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
