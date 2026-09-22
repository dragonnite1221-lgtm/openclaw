// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import {
  hasTerminalControl,
  sanitizeStrictSingleLineText,
  sanitizeTerminalText,
} from "./safe-text.js";

// Built from numeric code points rather than embedded literally, for the
// same reason safe-text.ts's own patterns are: these are exactly the
// "Trojan Source"-style characters (and other non-printing control
// characters) under test, so the fixtures themselves must stay legible in
// an editor or diff instead of embedding raw control bytes.
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85); // C1 control
const C1_8D = String.fromCharCode(0x8d); // C1 control
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCodePoint(0x202e); // right-to-left override
const LRM = String.fromCodePoint(0x200e); // left-to-right mark
const RLM = String.fromCodePoint(0x200f); // right-to-left mark
const ALM = String.fromCodePoint(0x061c); // Arabic letter mark
const ZWJ = String.fromCodePoint(0x200d); // zero-width joiner

describe("hasTerminalControl", () => {
  it.each([
    ["C0", `safe${NUL}text`],
    ["DEL", `safe${DEL}text`],
    ["C1", `safe${NEL}text`],
  ])("detects %s controls", (_name, input) => {
    expect(hasTerminalControl(input)).toBe(true);
  });

  it("allows printable shell metacharacters and Unicode", () => {
    const replacementChar = String.fromCodePoint(0xfffd);
    expect(
      hasTerminalControl(`'"$&;|<>^()%![]{}\\\`-%PATH%-${replacementChar}${replacementChar}`),
    ).toBe(false);
  });
});

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText(`ab${NEL}${C1_8D}c`)).toBe("abc");
  });

  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeTerminalText(`${ESC}[2K${ESC}[1Arewritten`)).toBe("rewritten");
  });

  it("removes OSC clipboard payloads", () => {
    expect(sanitizeTerminalText(`safe${ESC}]52;c;YWJj${BEL}text`)).toBe("safetext");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });

  it("strips dangerous bidi override characters", () => {
    // U+202E (right-to-left override) is the classic "Trojan Source"-style
    // vector for making displayed text visually reorder away from its
    // actual byte order.
    expect(sanitizeTerminalText(`safe${RLO}reversed`)).toBe("safereversed");
  });

  it("preserves simple direction marks and joiners", () => {
    // sanitizeTerminalText is shared by callers that render arbitrary
    // prose (CLI messages, transcript utterances), so it keeps only the
    // override/isolate subset -- ZWJ/ZWNJ (needed for emoji sequences and
    // script shaping) and simple LRM/RLM marks (needed for ordinary
    // mixed-direction text) are left alone since neither reorders anything
    // beyond itself. See sanitizeStrictSingleLineText for callers that
    // need the full Bidi_Control set stripped.
    expect(sanitizeTerminalText(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
    expect(sanitizeTerminalText(`a${LRM}b`)).toBe(`a${LRM}b`);
  });
});

describe("sanitizeStrictSingleLineText", () => {
  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeStrictSingleLineText(`${ESC}[2K${ESC}[1Arewritten`)).toBe("rewritten");
  });

  it("strips dangerous bidi override characters", () => {
    expect(sanitizeStrictSingleLineText(`safe${RLO}reversed`)).toBe("safereversed");
  });

  it("preserves joiners needed for emoji sequences and script shaping", () => {
    // ZWJ/ZWNJ are Join_Control, not Bidi_Control -- they can't reorder
    // anything and are needed to keep composed emoji intact even here.
    expect(sanitizeStrictSingleLineText(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
  });

  it("strips the full Bidi_Control set, not just the override/isolate subset", () => {
    // This function is used for short, security-sensitive single-line
    // fields (ACP permission-prompt titles, tool names) where there is no
    // legitimate need for any directional mark, and the stakes of a
    // spoofed rendering are high. Unlike sanitizeTerminalText's narrower
    // pattern (needed to avoid corrupting arbitrary rendered prose), every
    // control in Unicode's official Bidi_Control property is removed here:
    // LRM, RLM, ALM, plus the stronger embedding/override and isolate
    // controls.
    expect(sanitizeStrictSingleLineText(`a${LRM}b`)).toBe("ab");
    expect(sanitizeStrictSingleLineText(`a${RLM}b`)).toBe("ab");
    expect(sanitizeStrictSingleLineText(`a${ALM}b`)).toBe("ab");
  });
});
