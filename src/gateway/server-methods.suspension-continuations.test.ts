import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { NodeRegistry } from "./node-registry.js";
import { QuestionManager } from "./question-manager.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleNodeInvokeProgress } from "./server-methods/nodes.handlers.invoke-progress.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { runGatewayShutdownSteps } from "./server-shutdown.js";
import type { GatewayWsClient } from "./server/ws-types.js";

afterEach(resetGatewayWorkAdmission);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createClient(role: "operator" | "node", connId = "conn-live"): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role,
      scopes: role === "operator" ? ["operator.admin"] : [],
      client: {
        id: role === "node" ? "node-1" : "cli",
        version: "test",
        platform: "test",
        mode: role,
      },
      ...(role === "node"
        ? {
            device: {
              id: "node-1",
              publicKey: "key",
              signature: "sig",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
  } as unknown as GatewayWsClient;
}

function createContext(owners: {
  nodeRegistry?: NodeRegistry;
  execApprovalManager?: ExecApprovalManager;
  questionManager?: QuestionManager;
}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), debug: vi.fn() },
    ...owners,
  } as unknown as GatewayRequestContext;
}

async function dispatch(params: {
  method: string;
  requestParams: Record<string, unknown>;
  context: GatewayRequestContext;
  client: GatewayWsClient;
  handler: GatewayRequestHandler;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${params.method}`,
      method: params.method,
      params: params.requestParams,
    },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: params.context,
    methodRegistry: createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "suspension-continuation-proof",
        name: params.method,
        handler: params.handler,
        scope: "operator.admin",
      }),
    ]),
  });
  return respond;
}

describe("draining Gateway completion ownership", () => {
  it.each(["exec.approval.resolve", "approval.resolve"] as const)(
    "admits only an exact live approval continuation through %s",
    async (method) => {
      const manager = new ExecApprovalManager();
      const client = createClient("operator");
      const context = createContext({ execApprovalManager: manager });
      const ownerReady = deferred();
      const root = tryBeginGatewayRootWorkAdmission();
      if (!root) {
        throw new Error("expected admitted approval owner");
      }
      const owner = root
        .run(async () => {
          const record = manager.create({ command: "echo ok" }, 60_000, "approval-owned");
          const decision = manager.register(record, 60_000);
          ownerReady.resolve();
          return await decision;
        })
        .finally(root.release);
      await ownerReady.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        respond(true, { applied: manager.resolve("approval-owned", "allow-once") });
      });
      const shape = method === "approval.resolve" ? { kind: "exec", decision: "allow-once" } : {};

      const wrong = await dispatch({
        method,
        requestParams: { id: "approval-unrelated", ...shape },
        context,
        client,
        handler,
      });
      expect(wrong).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(handler).not.toHaveBeenCalled();

      const accepted = await dispatch({
        method,
        requestParams: { id: "approval-owned", ...shape },
        context,
        client,
        handler,
      });
      expect(accepted).toHaveBeenCalledWith(true, { applied: true });
      await expect(owner).resolves.toBe("allow-once");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    },
  );

  it("admits exact question inspection and resolution without admitting unrelated roots", async () => {
    const manager = new QuestionManager();
    const client = createClient("operator");
    const context = createContext({ questionManager: manager });
    const root = tryBeginGatewayRootWorkAdmission();
    if (!root) {
      throw new Error("expected admitted question owner");
    }
    await root.run(async () => {
      manager.request({
        id: "question-owned",
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Continue?",
            options: [],
            isOther: true,
          },
        ],
        timeoutMs: 60_000,
      });
    });
    root.release();
    // question.request returns before question.waitAnswer begins. The pending
    // question itself retains the exact admitted root across that RPC boundary.
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.drain()).toBe(true);

    const inspected = await dispatch({
      method: "question.get",
      requestParams: { id: "question-owned" },
      context,
      client,
      handler: ({ respond }) => respond(true, { question: manager.get("question-owned") }),
    });
    expect(inspected).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ question: expect.any(Object) }),
    );

    const unrelated = await dispatch({
      method: "question.resolve",
      requestParams: { id: "question-unrelated" },
      context,
      client,
      handler: vi.fn(),
    });
    expect(unrelated).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    const answered = await dispatch({
      method: "question.resolve",
      requestParams: { id: "question-owned" },
      context,
      client,
      handler: ({ respond }) => {
        respond(true, manager.resolve("question-owned", { answers: { choice: ["yes"] } }));
      },
    });
    expect(answered).toHaveBeenCalledWith(true, {
      status: "answered",
      answers: { answers: { choice: ["yes"] } },
    });
    expect(manager.get("question-owned")).toMatchObject({ status: "answered" });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
    manager.reset();
  });

  it.each(["suspension", "restart", "shutdown"] as const)(
    "admits exact node completions during %s without admitting unrelated work",
    async (phase) => {
      const node = createClient("node");
      const registry = new NodeRegistry({
        resolveCurrentPairingState: async () => ({
          identity: "paired",
          generation: "generation-live",
        }),
      });
      registry.register(node, {
        pairingIdentity: "paired",
        pairingGeneration: "generation-live",
      });
      const context = createContext({ nodeRegistry: registry });
      const invokeReady = deferred<string>();
      const finishDelivery = deferred();
      const chunks: string[] = [];
      const controller = new AbortController();
      let result: Awaited<ReturnType<NodeRegistry["invoke"]>> | undefined;
      const invoke = async () => {
        result = await registry.invoke({
          nodeId: "node-1",
          command: "debug.ping",
          timeoutMs: 60_000,
          onProgress: (chunk) => chunks.push(chunk),
          onDispatchReady: invokeReady.resolve,
          signal: controller.signal,
        });
        await finishDelivery.promise;
      };
      const root = phase === "shutdown" ? null : tryBeginGatewayRootWorkAdmission();
      if (phase === "shutdown") {
        markGatewayRestartDraining();
      }
      const owner = root
        ? root.run(invoke).finally(root.release)
        : runGatewayShutdownSteps({
            steps: [{ name: "worker environment stop", run: invoke }],
            onError: (message) => {
              throw new Error(message);
            },
          });
      const invokeId = await Promise.race([
        invokeReady.promise,
        owner.then(() => {
          throw new Error("node invocation finished before its dispatch became ready");
        }),
      ]);
      const suspension = phase === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspension) {
        expect(suspension.drain()).toBe(true);
      } else {
        markGatewayRestartDraining();
      }

      try {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

        for (const rejected of [
          { id: "unrelated-invoke", nodeId: "node-1", client: node },
          { id: invokeId, nodeId: "other-node", client: node },
          { id: invokeId, nodeId: "node-1", client: createClient("node", "other-connection") },
        ]) {
          const ignored = await dispatch({
            method: "node.invoke.result",
            requestParams: { id: rejected.id, nodeId: rejected.nodeId, ok: true },
            context,
            client: rejected.client,
            handler: vi.fn(),
          });
          expect(ignored).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        }

        const malformed = await dispatch({
          method: "node.invoke.progress",
          requestParams: { invokeId, nodeId: "node-1", seq: -1, chunk: "invalid" },
          context,
          client: node,
          handler: handleNodeInvokeProgress,
        });
        expect(malformed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(chunks).toEqual([]);
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        const progressed = await dispatch({
          method: "node.invoke.progress",
          requestParams: { invokeId, nodeId: "node-1", seq: 0, chunk: "working" },
          context,
          client: node,
          handler: handleNodeInvokeProgress,
        });
        expect(progressed).toHaveBeenCalledWith(true, { ok: true, ignored: false }, undefined);
        expect(chunks).toEqual(["working"]);

        const completed = await dispatch({
          method: "node.invoke.result",
          requestParams: {
            id: invokeId,
            nodeId: "node-1",
            ok: true,
            payloadJSON: null,
            error: null,
          },
          context,
          client: node,
          handler: handleNodeInvokeResult,
        });
        expect(completed).toHaveBeenCalledWith(true, { ok: true }, undefined);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        const retired = await dispatch({
          method: "node.invoke.result",
          requestParams: { id: invokeId, nodeId: "node-1", ok: true },
          context,
          client: node,
          handler: vi.fn(),
        });
        expect(retired).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        finishDelivery.resolve();
        await owner;
        expect(result).toMatchObject({ ok: true, payloadJSON: null, error: null });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        controller.abort();
        finishDelivery.resolve();
        registry.unregister(node.connId);
        await owner;
        suspension?.release();
      }
    },
  );

  it.each(["connection", "pairing"] as const)(
    "rejects completion after the node %s changes during restart",
    async (replacement) => {
      const node = createClient("node");
      let generation = "generation-live";
      const registry = new NodeRegistry({
        resolveCurrentPairingState: async () => ({ identity: "paired", generation }),
      });
      registry.register(node, { pairingIdentity: "paired", pairingGeneration: generation });
      const root = tryBeginGatewayRootWorkAdmission();
      if (!root) {
        throw new Error("expected admitted node invocation owner");
      }
      const ready = deferred<string>();
      const finish = deferred();
      const owner = root
        .run(async () => {
          await registry.invoke({
            nodeId: "node-1",
            command: "debug.ping",
            onDispatchReady: ready.resolve,
            timeoutMs: 60_000,
          });
          await finish.promise;
        })
        .finally(root.release);
      try {
        const invokeId = await ready.promise;
        markGatewayRestartDraining();
        if (replacement === "connection") {
          registry.register(createClient("node", "replacement-connection"), {
            pairingIdentity: "paired",
            pairingGeneration: generation,
          });
        } else {
          generation = "generation-replaced";
          await registry.listCurrentConnected();
        }
        const handler = vi.fn();
        const result = await dispatch({
          method: "node.invoke.result",
          requestParams: { id: invokeId, nodeId: "node-1", ok: true },
          context: createContext({ nodeRegistry: registry }),
          client: node,
          handler,
        });
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(handler).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        registry.unregister(node.connId);
        registry.unregister("replacement-connection");
        await owner;
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );
});
