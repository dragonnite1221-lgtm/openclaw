import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Host-owned effect provenance for one completed tool lifecycle. */
export type ToolEffectReceipt = Readonly<{
  state: "not_started" | "read_completed" | "failed_no_effect" | "mutation_committed" | "uncertain";
}>;

/** Input-aware effect class declared by the concrete tool instance that owns the operation. */
export type ToolEffectClass = "read" | "mutation" | "unknown";
export type ToolEffectClassifier = (params: unknown) => ToolEffectClass;

/** Builds one owner classifier from the same closed action table used by its schema/handler. */
export function createActionEffectClassifier(
  effects: Readonly<Record<string, ToolEffectClass>>,
  defaultEffect: ToolEffectClass = "unknown",
): ToolEffectClassifier {
  return (params) => {
    if (!isRecord(params)) {
      return defaultEffect;
    }
    const action = params.action;
    return typeof action === "string" ? (effects[action] ?? "unknown") : defaultEffect;
  };
}

const toolEffectReceipts = new WeakMap<object, ToolEffectReceipt>();

/** Resolve the strongest effect fact available at the terminal lifecycle owner. */
export function buildToolEffectReceipt(params: {
  executionStarted: boolean;
  mutatingAction: boolean;
  replaySafe: boolean;
  outcome: "success" | "failure";
}): ToolEffectReceipt {
  if (!params.executionStarted) {
    // Hooks and approvals may have run before implementation entry. Only their
    // explicit no-start proof can upgrade this otherwise-uncertain boundary.
    return { state: "uncertain" };
  }
  if (params.replaySafe) {
    return {
      state: params.outcome === "success" ? "read_completed" : "failed_no_effect",
    };
  }
  return {
    state:
      params.mutatingAction && params.outcome === "success" ? "mutation_committed" : "uncertain",
  };
}

/** Bind provenance to the exact host-owned value crossing the next boundary. */
export function registerToolEffectReceipt<T>(target: T, receipt: ToolEffectReceipt): T {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    toolEffectReceipts.set(target, receipt);
  }
  return target;
}

/** Move one receipt across a host-owned projection without making it model-visible. */
export function transferToolEffectReceipt(source: unknown, target: unknown): void {
  const receipt = consumeToolEffectReceipt(source);
  if (receipt) {
    registerToolEffectReceipt(target, receipt);
  }
}

/** Consume provenance once so copied or replayed values cannot inherit authority. */
export function consumeToolEffectReceipt(target: unknown): ToolEffectReceipt | undefined {
  let current = target;
  const seen = new Set<unknown>();
  while (
    ((typeof current === "object" && current !== null) || typeof current === "function") &&
    !seen.has(current) &&
    seen.size < 8
  ) {
    seen.add(current);
    const receipt = toolEffectReceipts.get(current);
    toolEffectReceipts.delete(current);
    if (receipt) {
      return receipt;
    }
    try {
      current = current instanceof Error ? current.cause : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Return whether one recorded operation state proves that no mutation could have occurred. */
export function toolEffectStateProvesNoEffect(state: ToolEffectReceipt["state"]): boolean {
  return state === "not_started" || state === "read_completed" || state === "failed_no_effect";
}
