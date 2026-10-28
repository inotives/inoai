import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { promisify } from "node:util";
import {
  bootstrapRuntimeHome,
  inspectRuntimeHomeLock,
  InvalidRuntimeHomeError,
  resolveRuntimeHome,
  UnsafeRuntimeHomeError,
  systemProcessIdentity,
  type RuntimeHome,
  type RuntimeHomeLockState,
} from "../agent-instance/runtime-home.js";
import { inspectLaunchAgent, launchctl as defaultLaunchctl, renderLaunchAgent, type LaunchAgentStatus, type Launchctl } from "./launchagent.js";

const execFile = promisify(execFileCallback);

export type HeartbeatSetupCommand = {
  connectDirectory: string;
};

export function parseHeartbeatSetupCommand(args: string[]): HeartbeatSetupCommand {
  const usage = "Usage: inoai heartbeat setup --connect-dir <.inoai-connect*>";
  if (args.length !== 2 || args[0] !== "--connect-dir" || !args[1] || args[1].startsWith("--")) {
    throw new Error(usage);
  }
  return { connectDirectory: args[1] };
}

type SetupRuntimeValidator = (launchDirectory: string, connectDirectory: string) => Promise<RuntimeHome>;
type SetupEntrypointCheck = (entrypoint: string) => Promise<boolean>;
type SetupLockInspector = (lockFile: string, expectedPid?: number) => Promise<RuntimeHomeLockState>;
type SetupStatusProbe = (target: string) => Promise<LaunchAgentStatus>;
type SetupChildPids = (pid: number) => Promise<number[]>;
type SetupProcessAlive = (pid: number) => boolean | undefined;
type SetupClock = { now(): number; sleep(milliseconds: number): Promise<void> };
type SetupProbe = <T>(operation: () => Promise<T>, timeoutMs: number) => Promise<T>;

export type HeartbeatSetupFileSystem = {
  readFile: (path: string) => Promise<string>;
  mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<void>;
  writeFile: (path: string, data: string, options?: { mode?: number }) => Promise<void>;
  rename: (source: string, destination: string) => Promise<void>;
  rm: (path: string, options?: { force?: boolean }) => Promise<void>;
};

const defaultFileSystem: HeartbeatSetupFileSystem = {
  readFile: async (path) => readFile(path, "utf8"),
  mkdir: async (path, options) => { await mkdir(path, options); },
  writeFile: async (path, data, options) => { await writeFile(path, data, options); },
  rename: async (source, destination) => { await rename(source, destination); },
  rm: async (path, options) => { await rm(path, options); },
};

export type HeartbeatSetupDependencies = {
  platform?: string;
  userHome?: string;
  nodeExecutable?: string;
  uid?: number;
  entrypointExists?: SetupEntrypointCheck;
  validateRuntime?: SetupRuntimeValidator;
  inspectLock?: SetupLockInspector;
  serviceStatus?: SetupStatusProbe;
  childPids?: SetupChildPids;
  processAlive?: SetupProcessAlive;
  clock?: SetupClock;
  probeTimeoutMs?: number;
  expectedLockPid?: number;
  fileSystem?: HeartbeatSetupFileSystem;
  launchctl?: Launchctl;
};

const defaultClock: SetupClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function defaultChildPids(pid: number): Promise<number[]> {
  try {
    const result = await execFile("pgrep", ["-P", String(pid)]);
    return result.stdout.split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw new Error("Heartbeat setup process status unavailable");
  }
}

async function defaultEntrypointExists(entrypoint: string): Promise<boolean> {
  try {
    return (await stat(entrypoint)).isFile();
  } catch {
    return false;
  }
}

function setupRuntimeError(error: unknown): Error {
  if (error instanceof InvalidRuntimeHomeError) {
    return new Error("Heartbeat setup target is invalid; use a direct-child .inoai-connect* or .robin-* directory");
  }
  if (error instanceof UnsafeRuntimeHomeError) {
    return new Error("Heartbeat setup target is unsafe; the runtime home must not be a symlink");
  }
  return new Error("Heartbeat setup could not validate the target runtime");
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

const withProbeTimeout: SetupProbe = (operation, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    reject(new Error("Heartbeat setup probe timed out"));
  }, Math.max(1, timeoutMs));
  Promise.resolve().then(operation).then((value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  }, () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error("Heartbeat setup probe failed"));
  });
});

function lockError(state: Exclude<RuntimeHomeLockState, "missing" | "stale">): Error {
  if (state === "live" || state === "foreign") {
    return new Error("Heartbeat setup cannot proceed: the runtime lock has an active owner; stop that process before retrying");
  }
    return new Error(`Heartbeat setup cannot proceed: runtime lock ownership is ${state}; inspect it before retrying`);
}

export type HeartbeatSetupPreflight = {
  runtimeHome: RuntimeHome;
  executable: string;
};

export type HeartbeatSetupReconciliation = {
  changed: boolean;
  loaded: boolean;
  plistPath: string;
  target: string;
  previousPlist?: string;
  previousLoaded: boolean;
};

function targetFor(label: string, uid: number): string {
  return `gui/${uid}/${label}`;
}

async function readOptional(fileSystem: HeartbeatSetupFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fileSystem.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(fileSystem: HeartbeatSetupFileSystem, path: string, contents: string): Promise<void> {
  const temporary = `${path}.inoai-setup-tmp`;
  await fileSystem.writeFile(temporary, contents, { mode: 0o600 });
  try {
    await fileSystem.rename(temporary, path);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function reconcileHeartbeatSetup(
  repository: string,
  command: HeartbeatSetupCommand,
  preflight: HeartbeatSetupPreflight,
  supplied: HeartbeatSetupDependencies = {},
): Promise<HeartbeatSetupReconciliation> {
  const fileSystem = supplied.fileSystem ?? defaultFileSystem;
  const rendered = renderLaunchAgent(repository, {
    operation: "install",
    connectDirectory: command.connectDirectory,
    runAtLoad: true,
    keepAlive: true,
  }, supplied.userHome, supplied.nodeExecutable);
  if (rendered.executable !== preflight.executable) {
    throw new Error("Heartbeat setup target changed during reconciliation; retry the setup");
  }

  const uid = supplied.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Heartbeat setup requires a macOS user id");
  const target = targetFor(rendered.label, uid);
  const control = supplied.launchctl ?? defaultLaunchctl;
  let previousPlist: string | undefined;
  let priorLoaded: boolean;
  try {
    previousPlist = await readOptional(fileSystem, rendered.plistPath);
    priorLoaded = await control(["print", target]);
  } catch {
    throw new Error("Heartbeat setup could not inspect the target service");
  }

  if (previousPlist === rendered.plist) {
    return { changed: false, loaded: priorLoaded, plistPath: rendered.plistPath, target, previousPlist, previousLoaded: priorLoaded };
  }
  if (priorLoaded && previousPlist === undefined) {
    throw new Error("Heartbeat setup found a loaded target without its plist; refusing an unrecoverable replacement");
  }

  try {
    if (priorLoaded) {
      await control(["kill", "SIGTERM", target]);
      await control(["bootout", target]);
    }
    await fileSystem.mkdir(dirname(rendered.plistPath), { recursive: true });
    await fileSystem.mkdir(rendered.logs, { recursive: true, mode: 0o700 });
    await writeAtomic(fileSystem, rendered.plistPath, rendered.plist);
    return { changed: true, loaded: false, plistPath: rendered.plistPath, target, previousPlist, previousLoaded: priorLoaded };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      if (previousPlist === undefined) await fileSystem.rm(rendered.plistPath, { force: true });
      else await writeAtomic(fileSystem, rendered.plistPath, previousPlist);
    } catch {
      rollbackErrors.push("plist rollback failed");
    }
    if (priorLoaded) {
      try {
        const restored = await control(["bootstrap", `gui/${uid}`, rendered.plistPath]);
        if (!restored) throw new Error("bootstrap returned not loaded");
      } catch {
        rollbackErrors.push("service rollback failed");
      }
    }
    const suffix = rollbackErrors.length ? "; rollback failed" : "";
    throw new Error(`Heartbeat setup reconciliation failed${suffix}`);
  }
}

export async function preflightHeartbeatSetup(
  repository: string,
  command: HeartbeatSetupCommand,
  supplied: HeartbeatSetupDependencies = {},
): Promise<HeartbeatSetupPreflight> {
  if ((supplied.platform ?? process.platform) !== "darwin") throw new Error("Heartbeat setup requires macOS");

  const checkout = resolve(repository);
  const executable = isSea() ? process.execPath : join(checkout, "dist", "index.js");
  const executableExists = supplied.entrypointExists ?? defaultEntrypointExists;
  if (!(await executableExists(executable))) {
    throw new Error("Heartbeat setup requires the compiled dist/index.js entrypoint; run npm run build");
  }

  let runtimeHome: RuntimeHome;
  try {
    runtimeHome = await (supplied.validateRuntime ?? bootstrapRuntimeHome)(checkout, command.connectDirectory);
  } catch (error) {
    throw setupRuntimeError(error);
  }

  let lockState: RuntimeHomeLockState;
  try {
    lockState = await withProbeTimeout(
      () => (supplied.inspectLock ?? inspectRuntimeHomeLock)(runtimeHome.lockFile, supplied.expectedLockPid),
      supplied.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
  } catch {
    throw new Error("Heartbeat setup could not inspect the runtime lock");
  }
  if (lockState !== "missing" && lockState !== "stale" && !(lockState === "live" && supplied.expectedLockPid !== undefined)) throw lockError(lockState);
  return { runtimeHome, executable };
}

type StartupChecks = {
  service: boolean;
  supervisor: boolean;
  child: boolean;
  lock: boolean;
};

const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 100;

function startupFailure(checks: StartupChecks): Error {
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return new Error(`Heartbeat setup verification timed out: ${failed.join(", ") || "startup state unavailable"}`);
}

async function findExistingLockOwner(
  repository: string,
  command: HeartbeatSetupCommand,
  supplied: HeartbeatSetupDependencies,
  runtimeHome: RuntimeHome,
): Promise<number | undefined> {
  const uid = supplied.uid ?? process.getuid?.();
  if (uid === undefined) return undefined;
  const rendered = renderLaunchAgent(repository, { operation: "install", connectDirectory: command.connectDirectory, runAtLoad: true, keepAlive: true }, supplied.userHome, supplied.nodeExecutable);
  const target = targetFor(rendered.label, uid);
  try {
    const status = await withProbeTimeout(
      () => (supplied.serviceStatus ?? inspectLaunchAgent)(target),
      supplied.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    if (!status.loaded || status.supervisorPid === undefined) return undefined;
    const children = await withProbeTimeout(
      () => (supplied.childPids ?? defaultChildPids)(status.supervisorPid!),
      supplied.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    const alive = supplied.processAlive ?? systemProcessIdentity.processAlive;
    const inspectLock = supplied.inspectLock ?? inspectRuntimeHomeLock;
    for (const childPid of children) {
      if (alive(childPid) !== true) continue;
      if (await withProbeTimeout(
        () => inspectLock(runtimeHome.lockFile, childPid),
        supplied.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ) === "live") return childPid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function verifyHeartbeatStartup(
  target: string,
  runtimeHome: RuntimeHome,
  supplied: HeartbeatSetupDependencies,
): Promise<void> {
  const statusProbe = supplied.serviceStatus ?? inspectLaunchAgent;
  const childPids = supplied.childPids ?? defaultChildPids;
  const processAlive = supplied.processAlive ?? systemProcessIdentity.processAlive;
  const inspectLock = supplied.inspectLock ?? inspectRuntimeHomeLock;
  const clock = supplied.clock ?? defaultClock;
  const probeTimeoutMs = supplied.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = clock.now() + STARTUP_TIMEOUT_MS;
  let checks: StartupChecks = { service: false, supervisor: false, child: false, lock: false };
  while (true) {
    checks = { service: false, supervisor: false, child: false, lock: false };
    try {
      const remainingBeforeProbe = deadline - clock.now();
      if (remainingBeforeProbe <= 0) throw startupFailure(checks);
      const probeTimeout = Math.min(probeTimeoutMs, remainingBeforeProbe);
      const status = await withProbeTimeout(() => statusProbe(target), probeTimeout);
      checks.service = status.loaded;
      checks.supervisor = status.loaded && status.supervisorPid !== undefined && processAlive(status.supervisorPid) === true;
      if (checks.supervisor && status.supervisorPid !== undefined) {
        const remainingBeforeChildren = deadline - clock.now();
        if (remainingBeforeChildren <= 0) throw startupFailure(checks);
        const children = await withProbeTimeout(
          () => childPids(status.supervisorPid!),
          Math.min(probeTimeoutMs, remainingBeforeChildren),
        );
        for (const childPid of children) {
          if (processAlive(childPid) !== true) continue;
          checks.child = true;
          const remainingBeforeLock = deadline - clock.now();
          if (remainingBeforeLock <= 0) throw startupFailure(checks);
          if (await withProbeTimeout(
            () => inspectLock(runtimeHome.lockFile, childPid),
            Math.min(probeTimeoutMs, remainingBeforeLock),
          ) === "live") {
            checks.lock = true;
            break;
          }
        }
      }
      if (checks.service && checks.supervisor && checks.child && checks.lock) return;
    } catch {
      // Retry with a fixed, sanitized status. The final error never includes command output.
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw startupFailure(checks);
    await clock.sleep(Math.min(STARTUP_POLL_MS, remaining));
  }
}

async function requireLaunchctl(control: Launchctl, args: string[], action: string): Promise<void> {
  if (!(await control(args))) throw new Error(`Heartbeat setup could not ${action}`);
}

async function rollbackHeartbeatSetup(
  reconciliation: HeartbeatSetupReconciliation,
  supplied: HeartbeatSetupDependencies,
): Promise<void> {
  const fileSystem = supplied.fileSystem ?? defaultFileSystem;
  const control = supplied.launchctl ?? defaultLaunchctl;
  const uid = supplied.uid ?? process.getuid?.();
  const rollbackErrors: string[] = [];
  if (uid === undefined) throw new Error("Heartbeat setup rollback requires a macOS user id");
  try {
    if (await control(["print", reconciliation.target])) {
      await control(["kill", "SIGTERM", reconciliation.target]);
      await control(["bootout", reconciliation.target]);
    }
  } catch { rollbackErrors.push("service rollback failed"); }
  try {
    if (reconciliation.previousPlist === undefined) await fileSystem.rm(reconciliation.plistPath, { force: true });
    else await writeAtomic(fileSystem, reconciliation.plistPath, reconciliation.previousPlist);
  } catch { rollbackErrors.push("plist rollback failed"); }
  if (reconciliation.previousLoaded && reconciliation.previousPlist !== undefined) {
    try {
      await requireLaunchctl(control, ["bootstrap", `gui/${uid}`, reconciliation.plistPath], "restore the previous service");
    } catch { rollbackErrors.push("service restore failed"); }
  }
  if (rollbackErrors.length) throw new Error(rollbackErrors.join("; "));
}

export async function runHeartbeatSetup(
  repository: string,
  command: HeartbeatSetupCommand,
  supplied: HeartbeatSetupDependencies = {},
): Promise<string> {
  let reconciliation: HeartbeatSetupReconciliation | undefined;
  try {
    let expectedLockPid = supplied.expectedLockPid;
    if (expectedLockPid === undefined) {
      try {
        expectedLockPid = await findExistingLockOwner(
          repository,
          command,
          supplied,
          resolveRuntimeHome(resolve(repository), command.connectDirectory),
        );
      } catch {
        expectedLockPid = undefined;
      }
    }
    const preliminary = await preflightHeartbeatSetup(repository, command, {
      ...supplied,
      expectedLockPid,
    });
    reconciliation = await reconcileHeartbeatSetup(repository, command, preliminary, supplied);
    if (!reconciliation.loaded) {
      const control = supplied.launchctl ?? defaultLaunchctl;
      const uid = supplied.uid ?? process.getuid?.();
      if (uid === undefined) throw new Error("Heartbeat setup requires a macOS user id");
      await requireLaunchctl(control, ["bootstrap", `gui/${uid}`, reconciliation.plistPath], "load the target service");
      await requireLaunchctl(control, ["kickstart", "-k", reconciliation.target], "start the target service");
    }
    await verifyHeartbeatStartup(reconciliation.target, preliminary.runtimeHome, supplied);
    return `Heartbeat setup active (${reconciliation.changed ? "updated" : "unchanged"})\nTarget: ${reconciliation.target}\nChecks: service loaded, supervisor alive, child alive, runtime lock owned`;
  } catch (error) {
    if (reconciliation && (reconciliation.changed || !reconciliation.loaded)) {
      try { await rollbackHeartbeatSetup(reconciliation, supplied); }
      catch { throw new Error("Heartbeat setup failed; rollback failed"); }
    }
    const message = error instanceof Error ? error.message : "";
    if (/^Heartbeat setup (?:requires|target|cannot|could not|verification timed out|reconciliation failed)/u.test(message)) {
      throw new Error(message);
    }
    throw new Error("Heartbeat setup failed; inspect local heartbeat logs");
  }
}
