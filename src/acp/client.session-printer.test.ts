/** Tests ACP session-update printing: streamed-text sanitization and single-line field escaping. */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { createSessionUpdatePrinter } from "./client.js";

describe("createSessionUpdatePrinter", () => {
  function makeNotification(update: SessionNotification["update"]): SessionNotification {
    return { sessionId: "session-1", update };
  }

  it("preserves real newlines in streamed agent message text", () => {
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "line one\nline two" },
      }),
    );
    expect(written.join("")).toBe("line one\nline two");
  });

  it("strips a terminal control sequence from streamed agent message text", () => {
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before[2J[Hafter" },
      }),
    );
    expect(written.join("")).toBe("beforeafter");
  });

  it("strips a bare carriage return that would overwrite the current line", () => {
    // createStreamingBinaryOutputSanitizer deliberately preserves \r for its
    // other caller (shell progress bars); an ACP chat message has no such
    // legitimate use, and a bare \r left in place would let a server
    // overwrite already-printed text on the same line.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "safe\rspoofed" },
      }),
    );
    expect(written.join("")).toBe("safespoofed");
  });

  it("keeps a real CRLF line ending as a plain newline, even split across chunks", () => {
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "line one\r" },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\nline two" },
      }),
    );
    expect(written.join("")).toBe("line one\nline two");
  });

  it("preserves emoji ZWJ sequences and other legitimate format characters", () => {
    // A blanket Unicode Format-category strip (as shell output sanitization
    // uses) would split this into two separate emoji by removing the U+200D
    // zero-width joiner that combines them into one composed glyph.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    const womanTechnologist = "\u{1F469}‍\u{1F4BB}";
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `hello ${womanTechnologist} world` },
      }),
    );
    expect(written.join("")).toBe(`hello ${womanTechnologist} world`);
  });

  it("preserves an astral character split across two notification chunks", () => {
    // A server could send an emoji's high surrogate at the very end of one
    // chunk and its low surrogate at the start of the next. Treating each
    // chunk's surrogate independently (both "unpaired" on their own) would
    // silently delete the character entirely instead of reassembling it.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    const grinningFace = "\u{1F600}";
    const highSurrogate = grinningFace.charAt(0);
    const lowSurrogate = grinningFace.charAt(1);
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `before${highSurrogate}` },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${lowSurrogate}after` },
      }),
    );
    expect(written.join("")).toBe(`before${grinningFace}after`);
  });

  it("drops a high surrogate that turns out to be genuinely unpaired", () => {
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    const loneHighSurrogate = "\u{1F600}".charAt(0);
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `before${loneHighSurrogate}` },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "not-a-low-surrogate" },
      }),
    );
    expect(written.join("")).toBe("beforenot-a-low-surrogate");
  });

  it("does not synthesize an astral character across an ANSI sequence and an unrelated later chunk", () => {
    // Surrogate adjacency must be judged on the RAW stream, not on the
    // ANSI-stripped result: this high surrogate is immediately followed by
    // an ANSI clear-screen sequence in the actual data, never by anything
    // that could pair with it. Deciding adjacency AFTER stripping would
    // make it look like it ends the chunk, and combining it with an
    // unrelated low surrogate from a later chunk would fabricate a
    // character (here, an emoji) that the server never actually sent.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    const grinningFace = "\u{1F600}";
    const highSurrogate = grinningFace.charAt(0);
    const lowSurrogate = grinningFace.charAt(1);
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `safe${highSurrogate}[2J` },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${lowSurrogate}after` },
      }),
    );
    expect(written.join("")).toBe("safeafter");
  });

  it("reset() clears pending ANSI and surrogate state between prompt turns", () => {
    // Each prompt() call is a new, independent response from the agent --
    // an incomplete escape sequence or dangling surrogate half left at the
    // end of one turn must not leak into and corrupt the next.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first turn[" },
      }),
    );
    print.reset();
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "2Jsecond turn" },
      }),
    );
    // Without the reset, "2J" would be consumed as the pending CSI's
    // terminator instead of printed as ordinary text.
    expect(written.join("")).toBe("first turn2Jsecond turn");
  });

  it("resets pending message-chunk sanitizer state when a tool_call interrupts the stream", () => {
    // A tool_call notification is a real, visible interruption of the
    // agent_message_chunk stream (it logs its own line via `log`, not
    // `write`). An escape sequence left half-parsed from before the
    // interruption must not silently reach across it and consume text
    // belonging to a new, unrelated chunk of message content.
    const written: string[] = [];
    const lines: string[] = [];
    const print = createSessionUpdatePrinter({
      write: (text) => written.push(text),
      log: (line) => lines.push(line),
    });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before[" },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "ls",
        status: "pending",
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "2Jafter" },
      }),
    );
    // Without the reset, "2J" would be consumed as the dangling CSI's
    // terminator instead of printed as ordinary text.
    expect(written.join("")).toBe("before2Jafter");
  });

  it("strips dangerous bidi override characters", () => {
    // U+202E (right-to-left override) is the classic "Trojan Source"-style
    // vector for making displayed text visually reorder away from its
    // actual byte order.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "safe‮reversed" },
      }),
    );
    expect(written.join("")).toBe("safereversed");
  });

  it("strips a control sequence deliberately split across two chunks", () => {
    // A malicious or buggy server could send the escape introducer in one
    // notification and the rest of the sequence in the next, hoping a
    // per-chunk-only filter lets both halves through unsanitized.
    const written: string[] = [];
    const print = createSessionUpdatePrinter({ write: (text) => written.push(text) });
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before[2" },
      }),
    );
    print(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Jafter" },
      }),
    );
    expect(written.join("")).toBe("beforeafter");
  });

  it("sanitizes a tool_call title", () => {
    const lines: string[] = [];
    const print = createSessionUpdatePrinter({ log: (line) => lines.push(line) });
    print(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "exec[2Jclear screen",
        status: "pending",
      }),
    );
    expect(lines).toEqual(["\n[tool] execclear screen (pending)"]);
  });

  it("sanitizes a tool_call_update's toolCallId and status", () => {
    const lines: string[] = [];
    const print = createSessionUpdatePrinter({ log: (line) => lines.push(line) });
    print(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool\r[Hspoofed",
        status: "completed",
      }),
    );
    expect(lines).toEqual(["[tool update] tool\\rspoofed: completed"]);
  });

  it("sanitizes command names in available_commands_update", () => {
    const lines: string[] = [];
    const print = createSessionUpdatePrinter({ log: (line) => lines.push(line) });
    print(
      makeNotification({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help[2K", description: "d" },
          { name: "status", description: "d" },
        ],
      }),
    );
    expect(lines).toEqual(["\n[commands] /help /status"]);
  });
});
