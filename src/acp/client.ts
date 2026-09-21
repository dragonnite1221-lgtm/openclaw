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
  sanitizeTerminalText,
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
function createAcpChatTextSanitizer(): ((text: string) => string) & { reset: () => void } {
  const ansiStripper = new AnsiSequenceStripper();
  let pendingHighSurrogate = "";
  const sanitize = (rawText: string) => {
    // A high surrogate held from the previous chunk is only genuinely part
    // of a split character if THIS chunk's very first code unit is its
    // matching low surrogate. That check must happen against the raw
    // rawText -- before it gets combined into a buffer that ANSI stripping
    // will run over -- because an escape sequence sitting between them
    // would otherwise get removed and leave a previously-nonadjacent
    // surrogate pair newly adjacent, letting the surrogate-stripping step
    // below mistake it for a real character and preserve it. If the
    // pending surrogate isn't immediately followed by its match, it's
    // proven lone right now and dropped rather than reintroduced into text
    // that could later make it falsely adjacent to an unrelated surrogate.
    let withPending = rawText;
    if (pendingHighSurrogate) {
      const firstCode = rawText.codePointAt(0);
      const isMatchingLowSurrogate =
        firstCode !== undefined && firstCode >= 0xdc00 && firstCode <= 0xdfff;
      if (isMatchingLowSurrogate) {
        withPending = pendingHighSurrogate + rawText;
      }
      pendingHighSurrogate = "";
    }
    // A high surrogate at the very end of this buffer might be the first
    // half of an astral character (e.g. an emoji) split across two
    // notification chunks -- hold it back instead of treating it as an
    // invalid lone surrogate yet. It's proven genuinely unpaired only once
    // a later chunk's leading code unit turns out not to be its matching
    // low surrogate, in which case the surrogate-stripping step below
    // removes it as usual; if the stream simply ends first, it never gets
    // flushed, which is harmless. codePointAt at the last index can only
    // return a raw (unpaired) surrogate value here, since there is no
    // following code unit within this buffer to combine it with.
    const lastCode = withPending.codePointAt(withPending.length - 1);
    const endsWithUnpairedHighSurrogate =
      lastCode !== undefined && lastCode >= 0xd800 && lastCode <= 0xdbff;
    const toProcess = endsWithUnpairedHighSurrogate ? withPending.slice(0, -1) : withPending;
    if (endsWithUnpairedHighSurrogate) {
      pendingHighSurrogate = withPending.slice(-1);
    }
    const withoutAnsi = ansiStripper.write(toProcess);
    const withoutBidiOverrides = withoutAnsi.replace(DANGEROUS_BIDI_CONTROL_PATTERN, "");
    const withoutLoneSurrogates = withoutBidiOverrides.replace(/\p{Surrogate}/gu, "");
    if (!withoutLoneSurrogates) {
      return withoutLoneSurrogates;
    }
    const chunks: string[] = [];
    for (const char of withoutLoneSurrogates) {
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
      ansiStripper.finish();
      pendingHighSurrogate = "";
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
 * fields (titles, ids, status, command names) go through sanitizeTerminalText,
 * which escapes newlines instead of printing them since those fields are
 * never meant to span lines.
 */
export function createSessionUpdatePrinter(
  deps: SessionUpdatePrinterDeps = {},
): ((notification: SessionNotification) => void) & { reset: () => void } {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const log = deps.log ?? ((line: string) => console.log(line));
  const sanitizeStream = createAcpChatTextSanitizer();
  const printSessionUpdate = (notification: SessionNotification): void => {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type === "text") {
          write(sanitizeStream(update.content.text));
        }
        return;
      }
      case "tool_call": {
        // A tool_call is a real, visible interruption of the message-chunk
        // stream: it logs its own line rather than continuing the current
        // one. An escape sequence or surrogate half left dangling from
        // before the interruption must not reach across it and corrupt
        // text belonging to a new, unrelated chunk.
        sanitizeStream.reset();
        log(
          `\n[tool] ${sanitizeTerminalText(update.title)} (${sanitizeTerminalText(update.status ?? "unknown")})`,
        );
        return;
      }
      case "tool_call_update": {
        // ACP only requires toolCallId on this event -- status is commonly
        // absent on progress-only updates. Reset unconditionally: this is
        // still a real tool lifecycle event interrupting the message-chunk
        // stream even when this renderer has nothing to print for it.
        sanitizeStream.reset();
        if (update.status) {
          log(
            `[tool update] ${sanitizeTerminalText(update.toolCallId)}: ${sanitizeTerminalText(update.status)}`,
          );
        }
        return;
      }
      case "available_commands_update": {
        const names = update.availableCommands
          ?.map((cmd) => `/${sanitizeTerminalText(cmd.name)}`)
          .join(" ");
        if (names) {
          sanitizeStream.reset();
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
          return resolvePermissionRequest(params, { cwd });
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
