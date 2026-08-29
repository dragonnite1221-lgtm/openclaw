import { formatErrorMessage } from "../infra/errors.js";
import { runWithGatewayShutdownRootWorkAdmission } from "../process/gateway-work-admission.js";

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
};

/** Run every shutdown step even when one owner fails, with the failed owner named. */
export async function runGatewayShutdownSteps(params: {
  steps: readonly GatewayShutdownStep[];
  onError: (message: string) => void;
}): Promise<void> {
  // Node cleanup starts after restart admission closes. Keep its exact pending
  // replies owned until teardown settles, including startup-failure cleanup.
  await runWithGatewayShutdownRootWorkAdmission(async () => {
    for (const step of params.steps) {
      try {
        await step.run();
      } catch (error) {
        params.onError(`shutdown step failed (${step.name}): ${formatErrorMessage(error)}`);
      }
    }
  });
}
