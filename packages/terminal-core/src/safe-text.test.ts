// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import {
  hasTerminalControl,
  sanitizeStrictSingleLineText,
  sanitizeTerminalText,
} from "./safe-text.js";

describe("hasTerminalControl", () => {
  it.each([
    ["C0", "safe\u0000text"],
    ["DEL", "safe\u007ftext"],
    ["C1", "safe\u0085text"],
  ])("detects %s controls", (_name, input) => {
    expect(hasTerminalControl(input)).toBe(true);
  });

  it("allows printable shell metacharacters and Unicode", () => {
    expect(hasTerminalControl(`'"$&;|<>^()%![]{}\\\`-%PATH%-��`)).toBe(false);
  });
});

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText("ab\u0085\u008Dc")).toBe("abc");
  });

  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeTerminalText("\u001b[2K\u001b[1Arewritten")).toBe("rewritten");
  });

  it("removes OSC clipboard payloads", () => {
    expect(sanitizeTerminalText("safe\u001b]52;c;YWJj\u0007text")).toBe("safetext");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });

  it("strips dangerous bidi override characters", () => {
    // U+202E (right-to-left override) is the classic "Trojan Source"-style
    // vector for making displayed text visually reorder away from its
    // actual byte order.
    expect(sanitizeTerminalText("safe‮reversed")).toBe("safereversed");
  });

  it("preserves simple direction marks and joiners", () => {
    // sanitizeTerminalText is shared by callers that render arbitrary
    // prose (CLI messages, transcript utterances), so it keeps only the
    // override/isolate subset -- ZWJ/ZWNJ (needed for emoji sequences and
    // script shaping) and simple LRM/RLM marks (needed for ordinary
    // mixed-direction text) are left alone since neither reorders anything
    // beyond itself. See sanitizeStrictSingleLineText for callers that
    // need the full Bidi_Control set stripped.
    expect(sanitizeTerminalText("a‍b")).toBe("a‍b");
    expect(sanitizeTerminalText("a‎b")).toBe("a‎b");
  });
});

describe("sanitizeStrictSingleLineText", () => {
  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeStrictSingleLineText("[2K[1Arewritten")).toBe("rewritten");
  });

  it("strips dangerous bidi override characters", () => {
    expect(sanitizeStrictSingleLineText("safe‮reversed")).toBe("safereversed");
  });

  it("preserves joiners needed for emoji sequences and script shaping", () => {
    // ZWJ/ZWNJ are Join_Control, not Bidi_Control -- they can't reorder
    // anything and are needed to keep composed emoji intact even here.
    expect(sanitizeStrictSingleLineText("a‍b")).toBe("a‍b");
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
    expect(sanitizeStrictSingleLineText("a‎b")).toBe("ab"); // LRM
    expect(sanitizeStrictSingleLineText("a‏b")).toBe("ab"); // RLM
    expect(sanitizeStrictSingleLineText("a؜b")).toBe("ab"); // ALM
  });
});
