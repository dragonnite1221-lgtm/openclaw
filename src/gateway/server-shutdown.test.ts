import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runGatewayShutdownSteps } from "./server-shutdown.js";

afterEach(resetGatewayWorkAdmission);

describe("gateway shutdown steps", () => {
  it("names an unavailable module step and continues the remaining shutdown", async () => {
    const missingModule = Object.assign(new Error("Cannot find module 'rotated-chunk.js'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const loadStopModule = vi.fn(async () => {
      throw missingModule;
    });
    const closeGateway = vi.fn(async () => {});
    const messages: string[] = [];

    await runGatewayShutdownSteps({
      steps: [
        { name: "gateway lifetime sidecars", run: loadStopModule },
        { name: "gateway close", run: closeGateway },
      ],
      onError: (message) => messages.push(message),
    });

    expect(closeGateway).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      "shutdown step failed (gateway lifetime sidecars): Cannot find module 'rotated-chunk.js'",
    ]);
    expect(messages.join("\n")).not.toContain("shutdown error");
  });

  it.each(["complete", "reset"] as const)(
    "owns cleanup continuations until shutdown %s while new work stays closed",
    async (retirement) => {
      markGatewayRestartDraining();
      const ready =
        createDeferred<
          NonNullable<ReturnType<typeof captureGatewayRootWorkAdmissionContinuationScope>>
        >();
      const finish = createDeferred();
      const errors: string[] = [];
      const closing = runGatewayShutdownSteps({
        steps: [
          {
            name: "owned remote cleanup",
            run: async () => {
              const scope = captureGatewayRootWorkAdmissionContinuationScope();
              if (!scope) {
                throw new Error("shutdown has no cleanup completion owner");
              }
              ready.resolve(scope);
              await finish.promise;
            },
          },
        ],
        onError: (message) => errors.push(message),
      });
      try {
        const scope = await Promise.race([
          ready.promise,
          closing.then(() => {
            throw new Error(errors.join("\n") || "shutdown completed before cleanup became ready");
          }),
        ]);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
        await scope.run(async () => {
          expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
        });
        if (retirement === "reset") {
          resetGatewayWorkAdmission();
          markGatewayRestartDraining();
        } else {
          finish.resolve();
          await closing;
        }
        const resumed = vi.fn(async () => {});
        await expect(scope.run(resumed)).rejects.toThrow(
          "gateway root work continuation is no longer active",
        );
        expect(resumed).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      } finally {
        finish.resolve();
        await closing;
      }
      expect(errors).toEqual([]);
    },
  );
});
