import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { createDeferred } from "../helpers/promise.js";
import {
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";

async function waitForAdmissionControl<T>(pending: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CI_CHECKOUT_LIFETIME: admission control did not settle")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.skipIf(process.platform === "win32").each(["exec-Python", "prepared raw Python"])(
  "joins a Popen-admitted Git before receipt/deletion on parent stop (%s)",
  async (topology) => {
    const prepared = topology === "prepared raw Python";
    const server = createServer();
    let control: Socket | undefined;
    let controlEnded = false;
    let releasing = false;
    let input: Interface | undefined;
    let controlClosed = Promise.resolve();
    let caseDeadline: number | undefined;
    let workflowPid: number | undefined;
    const errors: unknown[] = [];
    const admitted = createDeferred<{ pid: number; parent: number }>();
    const prematureReceipt = createDeferred<never>();
    // Setup can fail before either promise is raced; keep the original failures observable.
    void admitted.promise.catch(() => undefined);
    void prematureReceipt.promise.catch(() => undefined);
    server.once("connection", (socket) => {
      control = socket;
      controlClosed = new Promise<void>((closed) => socket.once("close", closed));
      socket.once("end", () => (controlEnded = true));
      socket.once("error", (error) => {
        errors.push(error);
        admitted.reject(error);
      });
      input = createInterface({ input: socket });
      input.once("line", (line) => {
        try {
          admitted.resolve(JSON.parse(line));
        } catch (error) {
          admitted.reject(error);
        }
      });
      input.on("line", (line) => {
        if (line === "receipt-or-deletion-before-closure") {
          prematureReceipt.reject(
            new Error("CI_CHECKOUT_LIFETIME: held actor observed receipt/deletion before closure"),
          );
        }
      });
      if (releasing) {
        socket.end();
      }
    });
    try {
      const removedRoot = await withCiCheckoutFixture(
        `${prepared ? "linux:" : ""}parent-loss-before-registration`,
        async (root, deadline) => {
          caseDeadline = deadline;
          server.listen(0, "127.0.0.1");
          await waitForAdmissionControl(once(server, "listening"), deadline);
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Missing admission control address");
          }
          writeFileSync(path.join(root, "registration-gate.json"), JSON.stringify(address));
          let run = readCiCheckoutStep("checks-windows").run;
          if (prepared) {
            writeFileSync(
              path.join(root, "prepare.sh"),
              readCiCheckoutStep("security-fast", "Prepare Git owner").run,
            );
            // Preparation execs in its own shell. Keep outer Bash alive around
            // the actual saved-owner --git invocation, including its terminal output.
            run = `CHECKOUT_KIND=prepare bash --noprofile --norc -eo pipefail "$TMPDIR/prepare.sh"
python3 -I -S "$RUNNER_TEMP/ci-git-owner.py" --git 120 fetch --no-tags --depth=1 origin +${"c".repeat(40)}:refs/remotes/origin/npm-lock-base
printf 'raw owner returned\\n'
`;
          }
          writeFileSync(path.join(root, "checkout.sh"), run);
        },
        (report, result, stderr, root) => {
          const shell = expectDefined(
            report.ownedProcesses.find(({ role }) => role === "shell"),
            "workflow shell",
          );
          expect(shell.pid).toBe(workflowPid);
          expect(result, stderr).toEqual({ code: 1, signal: null });
          expect(report.error).toContain("test parent requested stop");
          if (prepared) {
            expect([
              { code: null, signal: "SIGTERM" },
              { code: 143, signal: null },
            ]).toContainEqual({ code: report.code, signal: report.signal });
            expect(report.output).not.toContain("raw owner returned");
          } else {
            expect(report.code).toBe(143);
            expect(report.signal).toBeNull();
          }
          expect(report.cleanupVerified).toBe(true);
          expect(report.cleanupErrors).toEqual([]);
          expect(report.cleanupRemaining).toEqual([]);
          expect(report.ownedProcesses.filter(({ attempt }) => attempt > 0)).toEqual([]);
          expect(report.boundaries.at(-1)).toMatchObject({
            name: "exit",
            alive: [],
            sentinelAlive: true,
          });
          expect(existsSync(root)).toBe(true);
          return root;
        },
        async (supervisor, root) => {
          const held = await waitForAdmissionControl(
            Promise.race([
              admitted.promise,
              prematureReceipt.promise,
              supervisor.wait().then(() => {
                throw new Error("CI_CHECKOUT_LIFETIME: supervisor closed before admission");
              }),
            ]),
            supervisor.observationDeadline,
          );
          expect(existsSync(path.join(root, "pids", `${held.pid}.json`))).toBe(false);
          workflowPid = held.parent;
          if (prepared) {
            // Inspect the live raw Python parent, not a PID-catalog inference.
            const parent = spawnSync(
              "/bin/ps",
              ["-ww", "-p", String(held.parent), "-o", "ppid=,command="],
              { encoding: "utf8", timeout: 1_000 },
            );
            expect(parent.status, parent.stderr).toBe(0);
            const row = expectDefined(
              parent.stdout.trim().match(/^(\d+)\s+(.+)$/u),
              "raw owner parent",
            );
            workflowPid = Number(row[1]);
            expect(workflowPid).not.toBe(held.parent);
            expect(row[2]).toContain(path.join(root, "temp", "ci-git-owner.py"));
            expect(row[2]).toContain("--git 120 fetch");
          }
          expect(existsSync(path.join(root, "report.json"))).toBe(false);
          supervisor.stop();
          // Peer EOF and the producer's inherited-output EOF independently cover
          // the actor held before registration. Never send parent-side disconnect.
          await waitForAdmissionControl(
            Promise.race([
              Promise.all([supervisor.wait(), controlClosed]),
              prematureReceipt.promise,
            ]),
            supervisor.observationDeadline,
          );
          expect(
            controlEnded,
            "CI_CHECKOUT_LIFETIME: admission control closed without peer EOF",
          ).toBe(true);
        },
      );
      expect(existsSync(removedRoot)).toBe(false);
    } catch (error) {
      errors.push(error);
    } finally {
      // Release the held actor on red/setup-failure paths and join only within
      // the original fixture deadline; disposing our socket never proves peer death.
      releasing = true;
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      if (control && !control.writableEnded && !control.destroyed) {
        control.end();
      }
      try {
        await waitForAdmissionControl(
          Promise.all([controlClosed, serverClosed]),
          caseDeadline ?? Date.now(),
        );
      } catch (error) {
        errors.push(error);
        control?.destroy();
      } finally {
        input?.close();
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "CI_CHECKOUT_LIFETIME: held admission regression failed");
    }
  },
  55_000,
);

it("joins an unregistered sentinel before supervisor close on disconnect", async () => {
  await withCiCheckoutFixture(
    "early-leader-exit",
    (root) => {
      writeFileSync(path.join(root, "checkout.sh"), "exit 99\n");
      const preload = path.join(root, "startup.mjs");
      // Fault only the asynchronous startup boundary; keep the real safe preflight.
      writeFileSync(
        preload,
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const [mode, root] = process.argv.slice(2);
if (mode === "sentinel") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "supervise") {
  const spawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    if (args[1]?.[1] === "sentinel") {
      assert(child.pid > 1, "sentinel spawn did not return an owned PID");
      // Record at the creator: proof must not depend on sentinel JS ever starting.
      writeFileSync(path.join(root, "spawned-pid"), String(child.pid));
      child.once("close", (code, signal) => {
        writeFileSync(path.join(root, "sentinel-close.json"), JSON.stringify({
          code, signal, reportExists: existsSync(path.join(root, "report.json")),
        }));
      });
      queueMicrotask(() => process.disconnect());
    }
    return child;
  };
  syncBuiltinESMExports();
}
`,
      );
      return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    },
    (report, result, stderr, root) => {
      const spawnedPid = path.join(root, "spawned-pid");
      const sentinelClose = path.join(root, "sentinel-close.json");
      expect(report.error, stderr).toBe("test parent disconnected");
      const pid = Number(readFileSync(spawnedPid, "utf8"));
      expect(isProcessAlive(pid), "supervisor closed with an unregistered writer alive").toBe(
        false,
      );
      expect(JSON.parse(readFileSync(sentinelClose, "utf8"))).toEqual({
        code: null,
        signal: "SIGKILL",
        reportExists: false,
      });
      expect(result, stderr).toEqual({ code: 1, signal: null });
      expect(report.ownedProcesses).toEqual([]);
      expect(report.cleanupRemaining).toEqual([]);
      expect(report.boundaries).toEqual([]);
      expect(report.commands).toEqual([]);
    },
  );
}, 55_000);

it.each(["prepare", "inspect"])(
  "removes checkout artifacts after %s assertion failure",
  async (phase) => {
    let root: string | undefined;
    await expect(
      withCiCheckoutFixture(
        "early-leader-exit",
        (directory) => {
          root = directory;
          expect(phase, "injected prepare assertion").not.toBe("prepare");
          writeFileSync(path.join(directory, "checkout.sh"), "exit 0\n");
        },
        (report, result, stderr) => {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expectCiCheckoutCleanup(report);
          expect(report.code, "injected inspect assertion").toBe(99);
        },
      ),
    ).rejects.toThrow(`injected ${phase} assertion`);
    expect(existsSync(expectDefined(root, "created checkout root"))).toBe(false);
  },
  55_000,
);

it.skipIf(process.platform === "win32").each(["census", "corrupt-report", "timeout"])(
  "retains checkout artifacts across failed outer-runner cleanup (%s)",
  async (fault) => {
    const preload = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
if (process.argv[2] === "sentinel" && fault === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (process.argv[2] === "supervise") {
  const root = process.argv[3], children = [], pending = new Set();
  const spawn = cp.spawn, spawnSync = cp.spawnSync, renameSync = fs.renameSync;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child.pid);
    pending.add(child);
    fs.writeFileSync(path.join(root, "creator-pids.json"), JSON.stringify([process.pid, ...children]));
    child.once("close", () => pending.delete(child));
    if (fault === "timeout") {
      // Notify after spawn returns and the fixture installs direct-child tracking.
      // Flush IPC before stalling; sentinel registration is deliberately blocked.
      queueMicrotask(() => {
        process.send({ type: "ci-checkout:sentinel-created", pids: [process.pid, child.pid] }, error => {
          if (error) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      });
    }
    return child;
  };
  cp.spawnSync = (...args) => {
    if (fault === "census" && args[0] === "/bin/ps" && children.length === 2 && pending.size === 0) {
      fs.writeFileSync(path.join(root, "closed-before-census.json"), JSON.stringify(children));
      throw new Error("injected final census failure after direct child close");
    }
    return spawnSync(...args);
  };
  fs.renameSync = (...args) => {
    const result = renameSync(...args);
    if (fault === "corrupt-report" && args[1] === path.join(root, "report.json")) {
      fs.writeFileSync(args[1], "null");
    }
    return result;
  };
  syncBuiltinESMExports();
}
`;
    // Use the actual outer namespace owner, including its cleanup on exit code 1.
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
const timeoutFault = process.argv[2] === "timeout";
let root, failure;
let supervisor, ready, onReady;
const fork = cp.fork;
if (timeoutFault) {
  ready = new Promise(resolve => {
    onReady = message => {
      if (message?.type === "ci-checkout:sentinel-created") resolve(message.pids);
    };
  });
  cp.fork = (...args) => {
    supervisor = fork(...args);
    supervisor.on("message", onReady);
    return supervisor;
  };
  syncBuiltinESMExports();
}
try {
  const { withCiCheckoutFixture } = await import(process.argv[1]);
  if (timeoutFault) mock.timers.enable({ apis: ["setTimeout"] });
  const completed = withCiCheckoutFixture("early-leader-exit", directory => {
    root = directory;
    fs.writeFileSync(path.join(root, "checkout.sh"), "exit 0\n");
    const preload = path.join(root, "fault.mjs");
    fs.writeFileSync(preload, "const fault = " + JSON.stringify(process.argv[2]) + ";\n" + process.argv[3]);
    return { NODE_OPTIONS: "--import=" + pathToFileURL(preload).href };
  }, (report, result, stderr) => {
    throw new Error("unexpected completed report: " + JSON.stringify({ report, result, stderr }));
  }).catch(error => {
    console.error(error);
    failure = String(error);
  });
  try {
    if (timeoutFault) {
      const pids = await Promise.race([ready, completed.then(() => {
        throw new Error("supervisor completed before the timeout probe was ready");
      })]);
      assert.equal(pids.length, 2);
      assert.equal(pids[0], supervisor.pid);
      assert.notEqual(pids[1], supervisor.pid);
      for (const pid of pids) {
        assert(Number.isInteger(pid) && pid > 1);
        process.kill(pid, 0);
      }
    }
  } finally {
    if (timeoutFault) {
      // Creation belongs to the supervisor, not a child's delayed self-registration.
      // Restore timers before the expired controller deadline starts real cleanup.
      mock.timers.tick(50_000);
      mock.timers.reset();
    }
    await completed;
  }
} catch (error) {
  console.error(error);
  failure = String(error);
} finally {
  if (timeoutFault) {
    mock.timers.reset();
    supervisor?.off("message", onReady);
    cp.fork = fork;
    syncBuiltinESMExports();
  }
}
console.log(JSON.stringify({ root, outerRoot: tmpdir(), failure,
  pids: JSON.parse(fs.readFileSync(path.join(root, "creator-pids.json"), "utf8")),
  closedBeforeCensus: fs.existsSync(path.join(root, "closed-before-census.json")),
}));
process.exitCode = 1;
`,
        new URL("./ci-checkout.test-support.ts", import.meta.url).href,
        fault,
        preload,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    const result = await completion;
    expect(stdout, stderr).not.toBe("");
    const evidence = JSON.parse(stdout) as {
      root: string;
      outerRoot: string;
      failure: string;
      pids: number[];
      closedBeforeCensus: boolean;
    };
    try {
      console.log(`${fault}: ${JSON.stringify({ result, ...evidence, stderr })}`);
      expect(result, stderr).toEqual({ code: 1, signal: null });
      expect(existsSync(evidence.outerRoot), "outer runner did not remove its own namespace").toBe(
        false,
      );
      expect(path.dirname(evidence.root)).toBe(
        realpathSync(fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url))),
      );
      expect(existsSync(evidence.root), stderr).toBe(true);
      expect(
        evidence.pids.every((pid) => !isProcessAlive(pid)),
        "fixture left owned processes alive",
      ).toBe(true);
      expect(stderr).toContain(
        `Checkout fixture retained at ${evidence.root}; no completed report.`,
      );
      expect(stderr).toContain("Supervisor close: true; group extinction: true.");
      if (fault === "census") {
        expect(evidence.closedBeforeCensus).toBe(true);
        expect(evidence.pids).toHaveLength(3);
        expect(stderr).toContain("injected final census failure after direct child close");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "timeout") {
        expect(evidence.pids).toHaveLength(2);
        expect(evidence.failure).toContain("did not close within 50000ms");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else {
        expect(evidence.failure).not.toContain("unexpected completed report");
        expect(readFileSync(path.join(evidence.root, "report.json"), "utf8")).toBe("null");
      }
    } finally {
      await Promise.all(evidence.pids.map((pid) => waitForDead(pid, 4_000)));
      rmSync(evidence.root, { recursive: true, force: true });
    }
  },
  55_000,
);
