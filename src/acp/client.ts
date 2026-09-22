/** Interactive stdio ACP client used to connect a terminal session to an OpenClaw ACP server. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { AnsiSequenceStripper } from "../../packages/terminal-core/src/ansi-sequences.js";
import {
  DANGEROUS_BIDI_CONTROL_PATTERN,
  sanitizeStrictSingleLineText,
} from "../../packages/terminal-core/src/safe-text.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
import {
  buildAcpClientStripKeys,
  resolveAcpClientSpawnEnv,
  resolveAcpClientSpawnInvocation,
  resolvePermissionRequest,
  shouldStripProviderAuthEnvVarsForAcpServer,
} from "./client-helpers.js";

type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
};

type AcpClientHandle = {
  client: ClientSideConnection;
  agent: ChildProcess;
  sessionId: string;
  resetSessionUpdatePrinter: () => void;
};

const ACP_SERVER_KILL_GRACE_MS = 1000;
const ACP_SERVER_FORCE_KILL_TIMEOUT_MS = 1000;
const ACP_SERVER_EXIT_POLL_MS = 25;

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!hasChildExited(child) && Date.now() < deadline) {
    await delay(ACP_SERVER_EXIT_POLL_MS);
  }
  return hasChildExited(child);
}

async function terminateAcpServer(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) {
    return;
  }

  if (child.pid) {
    // This child is not detached, so Unix cleanup must stay on its direct PID.
    // Windows still reaps descendants; both paths escalate if SIGTERM is ignored.
    killProcessTree(child.pid, {
      detached: false,
      graceMs: ACP_SERVER_KILL_GRACE_MS,
    });
  } else {
    child.kill("SIGTERM");
  }

  if (await waitForChildExit(child, ACP_SERVER_KILL_GRACE_MS + ACP_SERVER_FORCE_KILL_TIMEOUT_MS)) {
    return;
  }

  if (child.pid) {
    signalProcessTree(child.pid, "SIGKILL", { detached: false });
  } else {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, ACP_SERVER_FORCE_KILL_TIMEOUT_MS);
}

function toArgs(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildServerArgs(opts: AcpClientOptions): string[] {
  const args = ["acp", ...toArgs(opts.serverArgs)];
  if (opts.serverVerbose && !args.includes("--verbose") && !args.includes("-v")) {
    args.push("--verbose");
  }
  return args;
}

function resolveSelfEntryPath(): string | null {
  // Prefer a path relative to the built module location (dist/acp/client.js -> dist/entry.js).
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(here), "..", "entry.js");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // ignore
  }

  const argv1 = normalizeOptionalString(process.argv[1]);
  if (argv1) {
    return path.isAbsolute(argv1) ? argv1 : path.resolve(process.cwd(), argv1);
  }
  return null;
}

type SessionUpdatePrinterDeps = {
  write?: (text: string) => void;
  log?: (line: string) => void;
};

// A high surrogate is only genuinely part of a split character if it is
// IMMEDIATELY followed, in the raw stream, by its matching low surrogate.
// This must be checked with plain UTF-16 code units (charCodeAt), not
// codePointAt, which would silently auto-combine an already-valid pair and
// defeat the manual pairing check below.
function isHighSurrogateUnit(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
function isLowSurrogateUnit(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Walks raw text one UTF-16 code unit at a time and keeps only surrogates
 * that are genuinely adjacent to their pair IN THE RAW INPUT, dropping any
 * lone surrogate immediately (except one trailing at the very end, which
 * might complete across the next chunk and is returned as `pending`).
 *
 * This must run BEFORE any transformation that removes characters (ANSI
 * stripping, bidi stripping): if it ran after, removing an escape sequence
 * or bidi control that separated a high surrogate from an unrelated low
 * surrogate would leave them newly adjacent, and a downstream check that
 * only looks at the (already-stripped) result would mistake them for one
 * real character the server never actually sent.
 */
function stripUnpairedSurrogates(text: string): { validated: string; pending: string } {
  let validated = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (isHighSurrogateUnit(unit)) {
      const nextUnit = i + 1 < text.length ? text.charCodeAt(i + 1) : undefined;
      if (nextUnit !== undefined && isLowSurrogateUnit(nextUnit)) {
        validated += text.charAt(i) + text.charAt(i + 1);
        i++;
        continue;
      }
      if (i === text.length - 1) {
        // Might be the first half of a character split across the next
        // chunk boundary -- hold it rather than treating it as lone yet.
        return { validated, pending: text.charAt(i) };
      }
      continue; // not at the end and not followed by its match: provably lone
    }
    if (isLowSurrogateUnit(unit)) {
      continue; // any real pair was already consumed by the branch above
    }
    validated += text.charAt(i);
  }
  return { validated, pending: "" };
}

/**
 * Sanitizes one connection's untrusted agent_message_chunk text: ANSI/C1
 * escape sequences via a stateful AnsiSequenceStripper (state carried across
 * calls, so a sequence split across two notification chunks still gets
 * caught), then per-character handling for whatever isn't part of a
 * recognized escape sequence. Unlike shell-utils.ts's
 * createStreamingBinaryOutputSanitizer (built for process output, where
 * \r is a legitimate progress-bar character and stripping the whole Unicode
 * Format category is harmless), this keeps real newlines and format
 * characters intact and only removes \r and the shared dangerous-bidi
 * pattern (see safe-text.ts).
 */
function createAcpChatTextSanitizer(): ((text: string, messageId?: string | null) => string) & {
  reset: () => void;
} {
  const ansiStripper = new AnsiSequenceStripper();
  let pendingHighSurrogate = "";
  let hasSeenChunk = false;
  let lastMessageId: string | null = null;
  const doReset = () => {
    ansiStripper.finish();
    pendingHighSurrogate = "";
  };
  const sanitize = (rawText: string, messageId?: string | null) => {
    // ACP defines a changed messageId as a new message starting -- reset
    // first so a dangling escape sequence or surrogate half from a
    // previous message can't bleed into this one. `null` and `undefined`
    // are normalized to the same sentinel: a backend that never populates
    // messageId at all stays consistently "absent" and never triggers a
    // false reset, but a backend that only *sometimes* populates it still
    // gets a reset on the presence transition itself, not just on a
    // concrete-to-concrete change.
    const normalizedMessageId = messageId ?? null;
    if (hasSeenChunk && normalizedMessageId !== lastMessageId) {
      doReset();
    }
    hasSeenChunk = true;
    lastMessageId = normalizedMessageId;

    // See stripUnpairedSurrogates: pending is prepended unconditionally
    // and re-validated from scratch, since a surrogate held from the
    // previous chunk is just as subject to this chunk's own raw adjacency
    // check as any surrogate that arrives fresh.
    const { validated, pending } = stripUnpairedSurrogates(pendingHighSurrogate + rawText);
    pendingHighSurrogate = pending;

    const withoutAnsi = ansiStripper.write(validated);
    const withoutBidiOverrides = withoutAnsi.replace(DANGEROUS_BIDI_CONTROL_PATTERN, "");
    if (!withoutBidiOverrides) {
      return withoutBidiOverrides;
    }
    const chunks: string[] = [];
    for (const char of withoutBidiOverrides) {
      const code = char.codePointAt(0);
      if (code == null) {
        continue;
      }
      if (code === 0x0a || code === 0x09) {
        chunks.push(char);
        continue;
      }
      if (code === 0x0d) {
        // No legitimate use in chat prose; a bare \r left in place would
        // let a server overwrite the start of the current terminal line.
        continue;
      }
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        chunks.push(`\\x${code.toString(16).padStart(2, "0")}`);
        continue;
      }
      chunks.push(char);
    }
    return chunks.join("");
  };
  return Object.assign(sanitize, {
    reset: () => {
      doReset();
      hasSeenChunk = false;
      lastMessageId = null;
    },
  });
}

/**
 * A remote ACP server's notifications are untrusted input: without
 * sanitization, a tool title, status, or streamed message chunk containing
 * terminal control sequences (screen clear, cursor movement) could overwrite
 * or hide what's already on screen. Multi-line message text keeps real
 * newlines (and legitimate format characters like emoji ZWJ sequences) via
 * a stateful, cross-chunk-safe sanitizer (one per connection, so a sequence
 * deliberately split across chunk boundaries still gets caught); single-line
 * fields (titles, ids, status, command names) go through
 * sanitizeStrictSingleLineText, which escapes newlines instead of printing
 * them since those fields are never meant to span lines.
 */
export function createSessionUpdatePrinter(
  deps: SessionUpdatePrinterDeps = {},
): ((notification: SessionNotification) => void) & { reset: () => void } {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const log = deps.log ?? ((line: string) => console.log(line));
  const sanitizeStream = createAcpChatTextSanitizer();
  const printSessionUpdate = (notification: SessionNotification): void => {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      write(sanitizeStream(update.content.text, update.messageId));
      return;
    }
    // Every other notification variant is a real break in the rendered
    // agent_message_chunk text stream: a non-text content block (image,
    // audio, resource) within the same message, a thought or user-echo
    // chunk, a tool event, a plan/mode update, or anything not yet
    // defined by the protocol. Resetting unconditionally here -- rather
    // than enumerating every case that needs it -- means a dangling
    // escape sequence or surrogate half can never bridge across ANY of
    // them into an unrelated, non-adjacent chunk of message text.
    sanitizeStream.reset();
    switch (update.sessionUpdate) {
      case "tool_call": {
        log(
          `\n[tool] ${sanitizeStrictSingleLineText(update.title)} (${sanitizeStrictSingleLineText(update.status ?? "unknown")})`,
        );
        return;
      }
      case "tool_call_update": {
        if (update.status) {
          log(
            `[tool update] ${sanitizeStrictSingleLineText(update.toolCallId)}: ${sanitizeStrictSingleLineText(update.status)}`,
          );
        }
        return;
      }
      case "available_commands_update": {
        const names = update.availableCommands
          ?.map((cmd) => `/${sanitizeStrictSingleLineText(cmd.name)}`)
          .join(" ");
        if (names) {
          log(`\n[commands] ${names}`);
        }
      }
      default:
    }
  };
  return Object.assign(printSessionUpdate, {
    // Clears the sanitizer's ANSI-parse state and any pending surrogate
    // half. Without this, an incomplete escape sequence or split surrogate
    // left dangling at the end of one prompt's response would silently
    // consume or corrupt the start of the next turn's text -- two
    // genuinely unrelated streams, not one continuous one, since a new
    // prompt() call is a new response from the agent.
    reset: () => {
      sanitizeStream.reset();
    },
  });
}

async function createAcpClient(opts: AcpClientOptions = {}): Promise<AcpClientHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  ensureOpenClawCliOnPath();
  const serverArgs = buildServerArgs(opts);

  const entryPath = resolveSelfEntryPath();
  const defaultServerCommand = entryPath ? process.execPath : "openclaw";
  const defaultServerArgs = entryPath ? [entryPath, ...serverArgs] : serverArgs;
  const serverCommand = opts.serverCommand ?? defaultServerCommand;
  const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : defaultServerArgs;
  const { getActiveSkillEnvKeys } = await import("../skills/runtime/env-overrides.runtime.js");
  const stripProviderAuthEnvVars = shouldStripProviderAuthEnvVarsForAcpServer({
    serverCommand,
    serverArgs: effectiveArgs,
    defaultServerCommand,
    defaultServerArgs,
  });
  const stripKeys = buildAcpClientStripKeys({
    stripProviderAuthEnvVars,
    activeSkillEnvKeys: getActiveSkillEnvKeys(),
  });
  const spawnEnv = resolveAcpClientSpawnEnv(process.env, { stripKeys });
  const spawnInvocation = resolveAcpClientSpawnInvocation(
    { serverCommand, serverArgs: effectiveArgs },
    {
      platform: process.platform,
      env: spawnEnv,
      execPath: process.execPath,
    },
  );

  log(`spawning: ${spawnInvocation.command} ${spawnInvocation.args.join(" ")}`);

  const agent = spawn(spawnInvocation.command, spawnInvocation.args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: spawnEnv,
    shell: spawnInvocation.shell,
    windowsHide: spawnInvocation.windowsHide,
  });

  agent.on("error", (err) => {
    log(`agent error: ${String(err)}`);
  });

  try {
    if (!agent.stdin || !agent.stdout) {
      throw new Error("Failed to create ACP stdio pipes");
    }

    const input = Writable.toWeb(agent.stdin);
    const output = Readable.toWeb(agent.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);
    const printSessionUpdate = createSessionUpdatePrinter();

    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          printSessionUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest) => {
          // A permission prompt is printed through a completely separate
          // channel (readline/console.error in resolvePermissionRequest,
          // not this sanitizer's write/log) and can stay open awaiting
          // input for a long time. It's a real, visible interruption of
          // the message-chunk stream on either side of it -- reset both
          // before (in case a chunk arrived just before this request came
          // in) and after (so the prompt itself can't leave state for the
          // next chunk to inherit).
          printSessionUpdate.reset();
          try {
            return await resolvePermissionRequest(params, { cwd });
          } finally {
            printSessionUpdate.reset();
          }
        },
      }),
      stream,
    );

    log("initializing");
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // The client object above only implements sessionUpdate and
      // requestPermission -- no fs/read_text_file, fs/write_text_file, or
      // terminal/* handlers exist, so advertising those capabilities would
      // let a server delegate work this client can't actually perform.
      // Both fields are optional; omitting them means "not supported."
      clientCapabilities: {},
      clientInfo: { name: "openclaw-acp-client", version: "1.0.0" },
    });

    log("creating session");
    const session = await client.newSession({
      cwd,
      mcpServers: [],
    });

    return {
      client,
      agent,
      sessionId: session.sessionId,
      resetSessionUpdatePrinter: printSessionUpdate.reset,
    };
  } catch (error) {
    await terminateAcpServer(agent);
    throw error;
  }
}

/** Starts the terminal prompt loop for a local ACP client session. */
export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<void> {
  const { client, agent, sessionId, resetSessionUpdatePrinter } = await createAcpClient(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("OpenClaw ACP client");
  console.log(`Session: ${sessionId}`);
  console.log('Type a prompt, or "exit" to quit.\n');

  const prompt = () => {
    rl.question("> ", (input) => {
      void (async () => {
        const text = input.trim();
        if (!text) {
          prompt();
          return;
        }
        if (text === "exit" || text === "quit") {
          await terminateAcpServer(agent);
          rl.close();
          process.exit(0);
        }

        try {
          const response = await client.prompt({
            sessionId,
            prompt: [{ type: "text", text }],
          });
          console.log(`\n[${response.stopReason}]\n`);
        } catch (err) {
          console.error(`\n[error] ${String(err)}\n`);
        } finally {
          // Each prompt() call is a new, independent response from the
          // agent -- an incomplete escape sequence or split surrogate left
          // dangling at the end of one turn's text must not leak into and
          // corrupt the start of the next. Reset regardless of success or
          // failure, since a mid-stream error can leave the same kind of
          // dangling state behind.
          resetSessionUpdatePrinter();
        }

        prompt();
      })();
    });
  };

  prompt();

  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code ?? 0}`);
    rl.close();
    process.exit(code ?? 0);
  });
}
