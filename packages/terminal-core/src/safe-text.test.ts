// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import { hasTerminalControl, sanitizeTerminalText } from "./safe-text.js";

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

  it("preserves joiners needed for emoji sequences and script shaping", () => {
    // ZWJ/ZWNJ are Join_Control, not Bidi_Control -- they can't reorder
    // anything and are needed to keep composed emoji and complex scripts
    // intact even in a single-line field.
    expect(sanitizeTerminalText("a‍b")).toBe("a‍b");
  });

  it("strips the full Bidi_Control set, not just the override/isolate subset", () => {
    // sanitizeTerminalText is used for short, security-sensitive
    // single-line fields (permission titles, tool names) where there is no
    // legitimate need for any directional mark, and the stakes of a
    // spoofed rendering are high. Unlike the narrower pattern applied to
    // long-form streamed chat text, every control in Unicode's official
    // Bidi_Control property is removed here: LRM, RLM, ALM, plus the
    // stronger embedding/override and isolate controls.
    expect(sanitizeTerminalText("a‎b")).toBe("ab"); // LRM
    expect(sanitizeTerminalText("a‏b")).toBe("ab"); // RLM
    expect(sanitizeTerminalText("a؜b")).toBe("ab"); // ALM
  });
});
