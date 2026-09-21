/** Tests ACP client permission request resolution (auto-approve/prompt/cancel routing). */
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { resolvePermissionRequest } from "./client-helpers.js";

function makePermissionRequest(
  overrides: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest {
  const { toolCall: toolCallOverride, options: optionsOverride, ...restOverrides } = overrides;
  const base: RequestPermissionRequest = {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "read: src/index.ts",
      status: "pending",
    },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
      { kind: "reject_once", name: "Reject once", optionId: "reject" },
    ],
  };

  return {
    ...base,
    ...restOverrides,
    toolCall: toolCallOverride ? { ...base.toolCall, ...toolCallOverride } : base.toolCall,
    options: optionsOverride ?? base.options,
  };
}

describe("resolvePermissionRequest", () => {
  async function expectPromptReject(params: {
    request: Partial<RequestPermissionRequest>;
    expectedToolName: string | undefined;
    expectedTitle: string;
  }) {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(makePermissionRequest(params.request), {
      prompt,
      log: () => {},
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(params.expectedToolName, params.expectedTitle);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  }

  async function expectAutoAllowWithoutPrompt(params: {
    request: Partial<RequestPermissionRequest>;
    cwd?: string;
  }) {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(makePermissionRequest(params.request), {
      prompt,
      log: () => {},
      cwd: params.cwd,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  }

  it("auto-approves safe tools without prompting", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(makePermissionRequest(), { prompt, log: () => {} });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for dangerous tool names inferred from title", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-2", title: "exec: uname -a", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("exec", "exec: uname -a");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("prompts for non-read/search tools (write)", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-w", title: "write: /tmp/pwn", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("write", "write: /tmp/pwn");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("prompts for exec-capable tools even when the action looks readonly", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-process-list",
          title: "process: list",
          status: "pending",
          rawInput: {
            name: "process",
            action: "list",
          },
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("process", "process: list");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("prompts for control-plane tools even on readonly-like actions", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-gateway-status",
          title: "gateway: status",
          status: "pending",
          rawInput: {
            name: "gateway",
            action: "status",
          },
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("gateway", "gateway: status");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it.each([
    {
      toolName: "cron",
      title: "cron: status",
      rawInput: {
        name: "cron",
        action: "status",
      },
    },
    {
      toolName: "nodes",
      title: "nodes: list",
      rawInput: {
        name: "nodes",
        action: "list",
      },
    },
  ] as const)(
    "prompts for shared backstop tools: $toolName",
    async ({ toolName, title, rawInput }) => {
      const prompt = vi.fn(async () => true);
      const res = await resolvePermissionRequest(
        makePermissionRequest({
          toolCall: {
            toolCallId: `tool-${toolName}`,
            title,
            status: "pending",
            rawInput,
          },
        }),
        { prompt, log: () => {} },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith(toolName, title);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    },
  );

  it("auto-approves search without prompting", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-s", title: "search: foo", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("auto-approves safe tools when rawInput is the only identity hint", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-raw-only",
          title: "Searching files",
          status: "pending",
          rawInput: {
            name: "search",
            query: "foo",
          },
        },
      }),
      { prompt, log: () => {} },
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("auto-approves search when rawInput path resolves inside cwd", async () => {
    await expectAutoAllowWithoutPrompt({
      request: {
        toolCall: {
          toolCallId: "tool-search-inside-cwd",
          title: "search: ignored-by-raw-input",
          status: "pending",
          rawInput: { name: "search", query: "TODO", path: "src" },
        },
      },
      cwd: "/tmp/openclaw-acp-cwd",
    });
  });

  it("prompts for search when rawInput path escapes cwd", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-search-escape-cwd",
          title: "search: ignored-by-raw-input",
          status: "pending",
          rawInput: { name: "search", query: "key", path: "../.ssh" },
        },
      }),
      { prompt, log: () => {}, cwd: "/tmp/openclaw-acp-cwd/workspace" },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("search", "search: ignored-by-raw-input");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("auto-approves search when query-like title text contains a path label", async () => {
    await expectAutoAllowWithoutPrompt({
      request: {
        toolCall: {
          toolCallId: "tool-search-title-query-path-label",
          title: "search: query: literal text, path: ~/.ssh",
          status: "pending",
          rawInput: { name: "search", query: "literal text, path: ~/.ssh" },
        },
      },
      cwd: "/tmp/openclaw-acp-cwd/workspace",
    });
  });

  it("prompts for search when explicit title path escapes cwd", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-search-title-escape-cwd",
          title: "search: path: ~/.ssh",
          status: "pending",
          rawInput: { name: "search", query: "key" },
        },
      }),
      { prompt, log: () => {}, cwd: "/tmp/openclaw-acp-cwd/workspace" },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("search", "search: path: ~/.ssh");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("auto-approves search when only locations resolve inside cwd", async () => {
    await expectAutoAllowWithoutPrompt({
      request: {
        toolCall: {
          toolCallId: "tool-search-location-inside-cwd",
          title: "search: TODO",
          status: "pending",
          rawInput: { name: "search", query: "TODO" },
          locations: [{ path: "src/index.ts" }],
        },
      },
      cwd: "/tmp/openclaw-acp-cwd",
    });
  });

  it("prompts for search when only locations escape cwd", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-search-location-escape-cwd",
          title: "search: TODO",
          status: "pending",
          rawInput: { name: "search", query: "TODO" },
          locations: [{ path: "/etc/passwd" }],
        },
      }),
      { prompt, log: () => {}, cwd: "/tmp/openclaw-acp-cwd/workspace" },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("search", "search: TODO");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("prompts when raw input spoofs a safe tool name for a dangerous title", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-exec-spoof",
          title: "exec: cat /etc/passwd",
          status: "pending",
          rawInput: {
            command: "cat /etc/passwd",
            name: "search",
          },
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(undefined, "exec: cat /etc/passwd");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("prompts for read outside cwd scope", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-r", title: "read: ~/.ssh/id_rsa", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("read", "read: ~/.ssh/id_rsa");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("auto-approves read when rawInput path resolves inside cwd", async () => {
    await expectAutoAllowWithoutPrompt({
      request: {
        toolCall: {
          toolCallId: "tool-read-inside-cwd",
          title: "read: ignored-by-raw-input",
          status: "pending",
          rawInput: { path: "docs/security.md" },
        },
      },
      cwd: "/tmp/openclaw-acp-cwd",
    });
  });

  it("auto-approves read when rawInput file URL resolves inside cwd", async () => {
    await expectAutoAllowWithoutPrompt({
      request: {
        toolCall: {
          toolCallId: "tool-read-inside-cwd-file-url",
          title: "read: ignored-by-raw-input",
          status: "pending",
          rawInput: { path: "file:///tmp/openclaw-acp-cwd/docs/security.md" },
        },
      },
      cwd: "/tmp/openclaw-acp-cwd",
    });
  });

  it.each(["FILE:///tmp/outside/marker.txt", "file:/tmp/outside/marker.txt"])(
    "prompts for read when non-canonical file URL escapes cwd: %s",
    async (fileUrl) => {
      const prompt = vi.fn(async () => false);
      const res = await resolvePermissionRequest(
        makePermissionRequest({
          toolCall: {
            toolCallId: "tool-read-file-url-escape-cwd",
            title: "read: ignored-by-raw-input",
            status: "pending",
            rawInput: { path: fileUrl },
          },
        }),
        { prompt, log: () => {}, cwd: "/tmp/openclaw-acp-cwd" },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith("read", "read: ignored-by-raw-input");
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    },
  );

  it("prompts for read when rawInput path escapes cwd via traversal", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-read-escape-cwd",
          title: "read: ignored-by-raw-input",
          status: "pending",
          rawInput: { path: "../.ssh/id_rsa" },
        },
      }),
      { prompt, log: () => {}, cwd: "/tmp/openclaw-acp-cwd/workspace" },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("read", "read: ignored-by-raw-input");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("prompts for read when scoped path is missing", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-read-no-path",
          title: "read",
          status: "pending",
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("read", "read");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("prompts for non-core read-like tool names", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-fr", title: "fs_read: ~/.ssh/id_rsa", status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("fs_read", "fs_read: ~/.ssh/id_rsa");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it.each([
    {
      caseName: "prompts for fetch even when tool name is known",
      toolCallId: "tool-f",
      title: "fetch: https://example.com",
      expectedToolName: "fetch",
    },
    {
      caseName: "prompts when tool name contains read/search substrings but isn't a safe kind",
      toolCallId: "tool-t",
      title: "thread: reply",
      expectedToolName: "thread",
    },
  ])("$caseName", async ({ toolCallId, title, expectedToolName }) => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId, title, status: "pending" },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(expectedToolName, title);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("prompts when kind is spoofed as read", async () => {
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-kind-spoof",
          title: "thread: reply",
          status: "pending",
          kind: "read",
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("thread", "thread: reply");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("uses reject_always when reject_once is absent", async () => {
    // allow_once is present, so this request is genuinely actionable in
    // both directions -- the missing piece here is specifically
    // reject_once, not the ability to allow at all.
    const options: RequestPermissionRequest["options"] = [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
    ];
    const prompt = vi.fn(async () => false);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-3", title: "gateway: reload", status: "pending" },
        options,
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject-always" } });
  });

  it("cancels without prompting when only allow_always is offered, even though reject_always could otherwise answer no", async () => {
    // Without allow_once, an "Allow ...? (y/N)" question is misleading
    // regardless of what the user would answer: a "yes" is a guaranteed
    // dead end, so the question is never asked at all -- not even to let
    // the user say "no" through reject_always, since the user can't know
    // in advance which answer would actually do something.
    const options: RequestPermissionRequest["options"] = [
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
    ];
    const prompt = vi.fn(async () => false);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-only-always", title: "gateway: reload", status: "pending" },
        options,
      }),
      { prompt, log },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[permission cancelled] gateway: missing allow_once option");
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels a manual approval instead of silently granting allow_always", async () => {
    // A plain "Allow ...? (y/N)" confirmation never told the user this
    // request would be granted beyond the current call, so approving it
    // must not fall back to a persistent grant just because allow_once
    // happens to be missing from this request's options. It must not even
    // ask the question: a "yes" answer here could never be honored, so
    // prompting first and discarding the answer as cancelled would be a
    // dead end that contradicts what was just asked.
    const options: RequestPermissionRequest["options"] = [
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ];
    const prompt = vi.fn(async () => true);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-manual-no-once",
          title: "gateway: reload",
          status: "pending",
        },
        options,
      }),
      { prompt, log },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[permission cancelled] gateway: missing allow_once option");
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels auto-approval instead of silently granting allow_always", async () => {
    // Same hazard on the auto-approve path: the classifier decided this
    // request never needs a prompt at all, so silently escalating to a
    // persistent grant would extend trust with no confirmation whatsoever.
    const prompt = vi.fn(async () => true);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        options: [{ kind: "allow_always", name: "Always allow", optionId: "allow-always" }],
      }),
      { prompt, log },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[permission cancelled] read: missing allow_once option");
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels auto-approved requests when no allow option is available", async () => {
    const prompt = vi.fn(async () => true);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-read-no-allow",
          title: "read: src/index.ts",
          status: "pending",
          kind: "read",
        },
        options: [{ kind: "reject_once", name: "Reject", optionId: "reject" }],
      }),
      { prompt, log },
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[permission cancelled] read: missing allow_once option");
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels with a clear reason when declining has no reject option either", async () => {
    const options: RequestPermissionRequest["options"] = [
      { kind: "allow_once", name: "Allow once", optionId: "allow" },
    ];
    const prompt = vi.fn(async () => false);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: { toolCallId: "tool-no-reject", title: "gateway: reload", status: "pending" },
        options,
      }),
      { prompt, log },
    );
    expect(log).toHaveBeenCalledWith("[permission cancelled] gateway: missing reject option");
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("prompts when tool identity is unknown and can still approve", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-4",
          title: "Modifying critical configuration file",
          status: "pending",
        },
      }),
      { prompt, log: () => {} },
    );
    expect(prompt).toHaveBeenCalledWith(undefined, "Modifying critical configuration file");
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("prompts when metadata tool name contains invalid characters", async () => {
    await expectPromptReject({
      request: {
        toolCall: {
          toolCallId: "tool-invalid-meta",
          title: "read: src/index.ts",
          status: "pending",
          _meta: { toolName: "read.*" },
        },
      },
      expectedToolName: undefined,
      expectedTitle: "read: src/index.ts",
    });
  });

  it("prompts when raw input tool name exceeds max length", async () => {
    await expectPromptReject({
      request: {
        toolCall: {
          toolCallId: "tool-long-raw",
          title: "read: src/index.ts",
          status: "pending",
          rawInput: { toolName: "r".repeat(129) },
        },
      },
      expectedToolName: undefined,
      expectedTitle: "read: src/index.ts",
    });
  });

  it("prompts when title tool name contains non-allowed characters", async () => {
    await expectPromptReject({
      request: {
        toolCall: {
          toolCallId: "tool-bad-title-name",
          title: "read🚀: src/index.ts",
          status: "pending",
        },
      },
      expectedToolName: undefined,
      expectedTitle: "read🚀: src/index.ts",
    });
  });

  it("returns cancelled when no permission options are present", async () => {
    const prompt = vi.fn(async () => true);
    const res = await resolvePermissionRequest(makePermissionRequest({ options: [] }), {
      prompt,
      log: () => {},
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("sanitizes tool titles before logging and prompting", async () => {
    const prompt = vi.fn(async () => false);
    const log = vi.fn();
    const res = await resolvePermissionRequest(
      makePermissionRequest({
        toolCall: {
          toolCallId: "tool-ansi",
          title: 'exec: \u001b[2K\u001b[1A\u001b[2K[permission] Allow "safe"? (y/N) \nnext',
          status: "pending",
        },
      }),
      { prompt, log },
    );

    expect(prompt).toHaveBeenCalledWith("exec", 'exec: [permission] Allow "safe"? (y/N) \\nnext');
    expect(log).toHaveBeenCalledWith(
      '\n[permission requested] exec: [permission] Allow "safe"? (y/N) \\nnext (exec) [exec_capable]',
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });
});
