import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(new URL("../fixtures/vitest-fork-shutdown.mjs", import.meta.url));

it.each([
  { scenario: "slow-exit", setup: "shared", fail: false, expectedProfiled: true },
  { scenario: "slow-exit", setup: "env", fail: true, expectedProfiled: true },
  { scenario: "natural-exit", setup: "raw", fail: false, expectedProfiled: true },
  { scenario: "plain", setup: "shared", fail: false, expectedProfiled: false },
  { scenario: "threads", setup: "env", fail: false, expectedProfiled: true },
  { scenario: "vmForks", setup: "raw", fail: false, expectedProfiled: false },
  { scenario: "custom", setup: "raw", fail: false, expectedProfiled: false },
  { scenario: "custom-opt-in", setup: "raw", fail: false, expectedProfiled: false },
  { scenario: "hung-cleanup", setup: "shared", fail: false, expectedProfiled: true },
  { scenario: "hung-exit", setup: "shared", fail: false, expectedProfiled: true },
  { scenario: "bad-exit", setup: "shared", fail: false, expectedProfiled: true },
  { scenario: "forced", setup: "raw", fail: false, expectedProfiled: false },
])("joins $scenario shutdown with $setup setup (test failure: $fail)", async (options) => {
  const root = tempDirs.make("vitest-fork-shutdown-");
  const { expectedProfiled, ...fixtureOptions } = options;
  const { stdout } = await execFileAsync(
    process.execPath,
    [fixture, root, JSON.stringify(fixtureOptions)],
    {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  const { scenario, setup, fail } = options;
  if (scenario === "forced") {
    // Node uses TerminateProcess for TERM on Windows; POSIX exercises escalation.
    expect(result.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    expect(result.stopped).toBe(true);
    return;
  }
  const brokenShutdown = scenario.startsWith("hung-") || scenario === "bad-exit";
  expect(result.code, result.output).toBe(fail || brokenShutdown ? 1 : 0);
  if (fail) {
    expect(result.output).toContain("intentional fixture failure");
  }
  expect(result.workerStopped).toBe(true);
  if (setup !== "raw") {
    // Windows has no wrapper-owned group cleanup after a forced termination.
    // Its unfinished home remains inside this test's auto-cleaned fixture root.
    expect(result.homeRemoved).toBe(!(process.platform === "win32" && scenario === "hung-cleanup"));
  }
  expect(result.callerPreserved).toBe(true);
  expect(result.profiled).toBe(expectedProfiled);
  if (!expectedProfiled) {
    expect(result.profiles.cpu, result.output).toBe(0);
    expect(result.profiles.heap, result.output).toBe(0);
  }
  if (scenario.startsWith("hung-")) {
    // Advance the real stop deadline only after the worker reaches the hung boundary.
    expect(result.events).toContainEqual({ event: "deadline", delay: 60_000 });
    expect(result.output).toContain("Timeout waiting for worker to respond");
    expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
      true,
    );
  } else if (scenario === "bad-exit") {
    expect(result.output).toContain("Worker exited during graceful shutdown");
  } else if (scenario === "custom") {
    expect(result.output).toContain("1 passed");
    expect(result.events).toContainEqual({ event: "parent-stop" });
    expect(result.events.some((event: { event: string }) => event.event === "deadline")).toBe(
      false,
    );
    expect(result.events).toContainEqual({ event: "terminate", signal: "SIGTERM" });
  } else if (scenario !== "plain") {
    if (expectedProfiled) {
      // Broken shutdowns cannot finish profiler cleanup, so profile validity stays
      // scoped to successful profiled exits as it was before this routing repair.
      expect(result.profiles.cpu, result.output).toBeGreaterThan(0);
      expect(result.profiles.heap, result.output).toBeGreaterThan(0);
    }
    expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
      false,
    );
    if (scenario === "slow-exit") {
      expect(result.events).toContainEqual({ event: "home-removed" });
    }
  }
});
