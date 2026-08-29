import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("worker bootstrap diagnostics", () => {
  it.each(["file", "symlink", "version failure", "absent"] as const)(
    "explains an unusable global install (%s) after registry failures",
    (kind) => {
      const home = fs.realpathSync(tempDirs.make("crabbox-bootstrap-"));
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      const cli = path.join(bin, "openclaw");
      if (kind !== "absent") {
        const target = kind === "symlink" ? path.join(home, "openclaw.mjs") : cli;
        fs.writeFileSync(
          target,
          "#!/bin/sh\necho 'runtime dependency: Permission denied' >&2\nexit 1\n",
          {
            mode: kind === "version failure" ? 0o700 : 0o600,
          },
        );
        if (kind === "symlink") {
          fs.symlinkSync(target, cli);
        }
      }
      fs.writeFileSync(
        path.join(bin, "npx"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$3" >>"$HOME/candidates"',
          'if [ "$3" = first ]; then echo "first candidate failure" >&2; else',
          '  printf "%02000d\\n" 0 >&2',
          '  echo "npm E404 last candidate missing; token=synthetic-registry-secret" >&2',
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o700 },
      );
      const setup = createCrabboxNodeEnrollmentSetup({
        leaseId: "cbx_test",
        enrollment: {
          mode: "connect",
          setupCode: "synthetic-setup-secret",
          setupId: "setup-test",
          openclawVersion: "2026.8.1",
          packageSpecs: ["first", "last"],
          displayName: "Bootstrap test",
          waitForDeviceId: async () => "device-test",
        },
      });
      const result = spawnSync("/bin/sh", [], {
        input: setup.command,
        encoding: "utf8",
        timeout: 10_000,
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...setup.forwardedEnv },
      });
      expect(result.status).toBe(1);
      expect(fs.readFileSync(path.join(home, "candidates"), "utf8")).toBe("first\nlast\n");
      const error = crabboxCommandError("node enrollment setup", {
        code: result.status,
        stdout: "setup progress ".repeat(200),
        stderr: result.stderr,
        signal: null,
        killed: false,
        termination: "exit",
      });
      expect(error.message).not.toContain("synthetic-registry-secret");
      expect(error.message).not.toContain("synthetic-setup-secret");
      expect(error.message.length).toBeLessThanOrEqual(570);
      if (kind === "file" || kind === "symlink") {
        expect(error.message).toContain("not readable/executable by node user");
        expect(error.message).toContain(cli);
        expect(error.message).toContain("-rw-------");
        expect(error.message).toContain("umask 022");
      } else if (kind === "version failure") {
        expect(error.message).toContain("runtime dependency: Permission denied");
      } else {
        expect(error.message).toContain("npm E404 last candidate missing");
        expect(error.message).not.toContain("first candidate failure");
      }
      const stateDir = path.join(home, ".openclaw", "cloud-workers", "cbx_test");
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
      expect(fs.statSync(path.join(stateDir, "setup-code")).mode & 0o777).toBe(0o600);
    },
  );
});

// The remote owner is Linux Bash; macOS's bundled Bash 3 cannot execute mapfile.
const hasBashMapfile = spawnSync("bash", ["-c", "type mapfile"], { encoding: "utf8" }).status === 0;

function runEnrollment(params: {
  desktop: boolean;
  display?: string;
  dbus?: string;
  runtimeDir?: string;
}) {
  const root = tempDirs.make("crabbox-desktop-enrollment-");
  const bin = path.join(root, "bin");
  const proc = path.join(root, "proc");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(proc, "123"), { recursive: true });
  fs.writeFileSync(path.join(root, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
  fs.writeFileSync(
    path.join(proc, "123", "environ"),
    [
      `DISPLAY=${params.display ?? ":99"}`,
      `DBUS_SESSION_BUS_ADDRESS=${params.dbus ?? "unix:path=/run/fixture/bus"}`,
      `XDG_RUNTIME_DIR=${params.runtimeDir ?? "/run/fixture"}`,
      "UNRELATED_DESKTOP_VALUE=do-not-export",
      "",
    ].join("\0"),
  );
  const writeCommand = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  writeCommand("pgrep", '[ "$*" = "-u $(id -u) -x xfce4-session" ]; echo 123');
  writeCommand("setsid", 'shift; exec "$@"');
  writeCommand(
    "openclaw",
    [
      'if [ "$*" = "--version" ]; then echo "OpenClaw 2026.8.1"; exit 0; fi',
      'printf "%s|%s|%s|%s|%s|%s\\n" "$*" "$OPENCLAW_STATE_DIR" "${DISPLAY-}" "${DBUS_SESSION_BUS_ADDRESS-}" "${XDG_RUNTIME_DIR-}" "${UNRELATED_DESKTOP_VALUE-}" >>"$HOME/calls"',
    ].join("\n"),
  );
  const setup = createCrabboxNodeEnrollmentSetup({
    desktop: params.desktop,
    leaseId: "cbx_fixture",
    enrollment: {
      mode: "resume",
      deviceId: "fixture-node",
      displayName: "Fixture worker",
      openclawVersion: "2026.8.1",
      packageSpecs: ["openclaw@2026.8.1"],
      waitForDeviceId: async () => "fixture-node",
    },
  });
  // Replace only OS filesystem roots; execute the generated enrollment program unchanged.
  const script = setup.command
    .replaceAll("/var/lib/crabbox/desktop.env", path.join(root, "desktop.env"))
    .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`);
  const result = spawnSync("bash", [], {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
      XDG_RUNTIME_DIR: "/run/wrong",
    },
  });
  const callsPath = path.join(root, "calls");
  return {
    result,
    calls: fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n") : [],
    root,
  };
}

describe.runIf(hasBashMapfile)("Crabbox desktop node enrollment", () => {
  it("enables the isolated CUA provider and starts the node in the exact XFCE session", () => {
    const { result, calls, root } = runEnrollment({ desktop: true });
    expect(result.status, result.stderr).toBe(0);
    const environment = `${root}/.openclaw/cloud-workers/cbx_fixture|:99|unix:path=/run/fixture/bus|/run/fixture|`;
    expect(calls).toEqual([
      `plugins enable cua-computer|${environment}`,
      `node run --ephemeral --display-name Fixture worker|${environment}`,
    ]);
  });

  it("does not enable CUA or inspect a desktop for a non-desktop lease", () => {
    const { result, calls, root } = runEnrollment({ desktop: false, display: ":wrong" });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      `node run --ephemeral --display-name Fixture worker|${root}/.openclaw/cloud-workers/cbx_fixture|:0|wrong-login-session|/run/wrong|`,
    ]);
  });

  it.each([{ display: ":0" }, { dbus: "" }, { runtimeDir: "relative-directory" }])(
    "refuses enrollment when the XFCE session binding is invalid: %j",
    (invalid) => {
      const { result, calls } = runEnrollment({ desktop: true, ...invalid });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("XFCE session");
      expect(calls).toEqual([]);
    },
  );
});
