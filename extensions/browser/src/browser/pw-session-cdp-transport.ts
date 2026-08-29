import type { lookup as dnsLookupCb } from "node:dns";
import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import WebSocket from "ws";
import { formatErrorMessage } from "../infra/errors.js";
import { openCdpWebSocket } from "./cdp.helpers.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
type CdpSocketLookup = typeof dnsLookupCb;
// Playwright allocates positive command IDs and reserves -9999 for Browser.close.
// Keep transport-owned replies below that range so Playwright never consumes them.
const FIRST_INTERNAL_COMMAND_ID = -10_000;

function isWorkerTargetType(type: string): boolean {
  return (
    type === "worker" || type.endsWith("_worker") || type === "worklet" || type.endsWith("_worklet")
  );
}

function workerSessionWithoutContext(message: Record<string, unknown>): string | undefined {
  if (readStringField(message, "method") !== "Target.attachedToTarget") {
    return undefined;
  }
  const params = asOptionalRecord(message.params);
  const targetInfo = asOptionalRecord(params?.targetInfo);
  const type = readStringField(targetInfo, "type");
  if (!type || !isWorkerTargetType(type) || readStringField(targetInfo, "browserContextId")) {
    return undefined;
  }
  return readStringField(params, "sessionId");
}

export async function connectOverCdpTransport(
  connectionUrl: string,
  opts: {
    timeout: number;
    headers: Record<string, string>;
    lookup?: CdpSocketLookup;
  },
): Promise<Browser> {
  const ws = openCdpWebSocket(connectionUrl, {
    headers: opts.headers,
    handshakeTimeoutMs: opts.timeout,
    lookup: opts.lookup,
    playwrightTransportDefaults: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });
    let onMessage: ((message: object) => void) | undefined;
    let onClose: ((reason?: string) => void) | undefined;
    const pendingMessages: object[] = [];
    let pendingCloseReason: string | undefined;
    let transportClosed = false;
    let transportCloseScheduled = false;
    let nextInternalCommandId = FIRST_INTERNAL_COMMAND_ID;
    const notifyTransportClosed = (reason: string) => {
      if (transportClosed) {
        return;
      }
      transportClosed = true;
      if (onClose) {
        onClose(reason);
        return;
      }
      pendingCloseReason = reason;
    };
    const scheduleTransportClosed = (reason: string) => {
      if (transportClosed || transportCloseScheduled) {
        return;
      }
      transportCloseScheduled = true;
      setImmediate(() => {
        transportCloseScheduled = false;
        notifyTransportClosed(reason);
      });
    };
    const closeTransportSocket = (reason = "CDP socket closed") => {
      notifyTransportClosed(reason);
      ws.close();
      const terminateTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }, 100);
      terminateTimer.unref?.();
    };
    const sendInternalCommand = (
      method: string,
      params: Record<string, unknown> | undefined,
      sessionId?: string,
    ) => {
      ws.send(
        JSON.stringify({
          id: nextInternalCommandId--,
          method,
          ...(params ? { params } : {}),
          sessionId,
        }),
      );
    };
    const releaseWorkerTarget = (sessionId: string) => {
      // Playwright pauses attached targets and requires resume before detach.
      // Release the exact worker session before hiding its unsupported attach event.
      sendInternalCommand("Runtime.runIfWaitingForDebugger", undefined, sessionId);
      sendInternalCommand("Target.detachFromTarget", { sessionId });
    };
    const scheduleMessage = (message: object) => {
      setImmediate(() => {
        if (transportClosed) {
          return;
        }
        if (!onMessage) {
          pendingMessages.push(message);
          return;
        }
        try {
          onMessage(message);
        } catch (error) {
          closeTransportSocket(formatErrorMessage(error));
        }
      });
    };
    const transport: ConnectOverCDPTransport = {
      send: (message) => {
        ws.send(JSON.stringify(message));
      },
      close: () => {
        closeTransportSocket();
      },
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
        if (!handler) {
          return;
        }
        while (pendingMessages.length > 0) {
          const pending = pendingMessages.shift();
          if (pending) {
            scheduleMessage(pending);
          }
        }
      },
      get onclose() {
        return onClose;
      },
      set onclose(handler) {
        onClose = handler;
        if (handler && pendingCloseReason !== undefined) {
          const reason = pendingCloseReason;
          pendingCloseReason = undefined;
          handler(reason);
        }
      },
    };
    ws.on("message", (raw) => {
      try {
        const parsed = asOptionalRecord(JSON.parse(rawDataToString(raw)));
        if (!parsed) {
          closeTransportSocket();
          return;
        }
        const id = parsed.id;
        if (typeof id === "number" && id <= FIRST_INTERNAL_COMMAND_ID) {
          return;
        }
        const workerSessionId = workerSessionWithoutContext(parsed);
        if (workerSessionId) {
          releaseWorkerTarget(workerSessionId);
          return;
        }
        scheduleMessage(parsed);
      } catch {
        closeTransportSocket();
      }
    });
    ws.on("close", () => {
      scheduleTransportClosed("CDP socket closed");
    });
    ws.on("error", (error) => {
      scheduleTransportClosed(formatErrorMessage(error));
    });
    return await getPlaywrightCore().chromium.connectOverCDP(transport, { timeout: opts.timeout });
  } catch (error) {
    ws.close();
    throw error;
  }
}
