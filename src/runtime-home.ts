import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const templates = {
  ".env": "",
  "agent.md": "# inoai\n",
} as const;

export type RuntimeHome = {
  directory: string;
  envFile: string;
  agentFile: string;
  databaseFile: string;
  lockFile: string;
};

export type RuntimeHomeLockRecord = {
  pid: number;
  started_at: string;
  token: string;
};

let selfProcessStartTime: Promise<string | undefined> | undefined;

/**
 * Returns the macOS-native process start-time value used for lock identity.
 *
 * The fallback is limited to this process because Node can provide a reliable
 * start estimate for itself, but not for an arbitrary PID. A missing value for
 * another process must remain unverifiable so startup can fail closed.
 */
export async function getMacProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  if (pid === process.pid && selfProcessStartTime) return selfProcessStartTime;
  const lookup = (async () => {
    try {
      const result = await execFile("ps", ["-p", String(pid), "-o", "lstart="]);
      const value = result.stdout.trim();
      return value || undefined;
    } catch (error: unknown) {
      if (pid !== process.pid) return undefined;
      return new Date(Date.now() - process.uptime() * 1_000).toISOString();
    }
  })();
  if (pid === process.pid) selfProcessStartTime = lookup;
  return lookup;
}

export class InvalidRuntimeHomeError extends Error {
  constructor(connectDirectory: string) {
    super(`Runtime home must be a direct-child .inoai-connect* directory: ${connectDirectory}`);
    this.name = "InvalidRuntimeHomeError";
  }
}

export class UnsafeRuntimeHomeError extends Error {
  constructor(directory: string) {
    super(`Runtime home must not be a symlink: ${directory}`);
    this.name = "UnsafeRuntimeHomeError";
  }
}

export function resolveRuntimeHome(launchDirectory: string, connectDirectory = ".inoai-connect"): RuntimeHome {
  if (
    !connectDirectory.startsWith(".inoai-connect") ||
    connectDirectory.includes("/") ||
    connectDirectory.includes("\\")
  ) {
    throw new InvalidRuntimeHomeError(connectDirectory);
  }
  const directory = resolve(launchDirectory, connectDirectory);
  return {
    directory,
    envFile: join(directory, ".env"),
    agentFile: join(directory, "agent.md"),
    databaseFile: join(directory, "inoai.sqlite"),
    lockFile: join(directory, "inoai.lock"),
  };
}

export async function bootstrapRuntimeHome(
  launchDirectory: string,
  connectDirectory?: string,
): Promise<RuntimeHome> {
  const home = resolveRuntimeHome(launchDirectory, connectDirectory);
  await mkdir(home.directory, { recursive: true, mode: 0o700 });
  if ((await lstat(home.directory)).isSymbolicLink()) {
    throw new UnsafeRuntimeHomeError(home.directory);
  }
  await Promise.all(
    Object.entries(templates).map(async ([name, contents]) => {
      try {
        await writeFile(join(home.directory, name), contents, { flag: "wx", mode: 0o600 });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }),
  );
  return home;
}

export class RuntimeHomeLockedError extends Error {
  constructor(directory: string) {
    super(`Runtime home is already locked: ${directory}`);
    this.name = "RuntimeHomeLockedError";
  }
}

type ExistingLockState = "live" | "stale" | "unverifiable";

function isLockRecord(value: unknown): value is RuntimeHomeLockRecord {
  return typeof value === "object" && value !== null
    && Number.isInteger((value as { pid?: unknown }).pid)
    && (value as { pid: number }).pid > 0
    && typeof (value as { started_at?: unknown }).started_at === "string"
    && (value as { started_at: string }).started_at.length > 0
    && typeof (value as { token?: unknown }).token === "string"
    && (value as { token: string }).token.length > 0;
}

function processAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

async function inspectExistingLock(lockFile: string): Promise<ExistingLockState> {
  if (process.platform !== "darwin") return "unverifiable";

  let record: unknown;
  try {
    record = JSON.parse(await readFile(lockFile, "utf8"));
  } catch {
    return "unverifiable";
  }
  if (!isLockRecord(record)) return "unverifiable";

  const alive = processAlive(record.pid);
  if (alive === undefined) return "unverifiable";
  if (!alive) return "stale";

  const currentStart = await getMacProcessStartTime(record.pid);
  if (!currentStart) return "unverifiable";
  return currentStart === record.started_at ? "live" : "stale";
}

export async function acquireRuntimeHomeLock(home: RuntimeHome): Promise<() => Promise<void>> {
  const record: RuntimeHomeLockRecord = {
    pid: process.pid,
    started_at: (await getMacProcessStartTime(process.pid)) ?? new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    token: randomUUID(),
  };
  const contents = `${JSON.stringify(record)}\n`;
  for (;;) {
    try {
      await writeFile(home.lockFile, contents, { flag: "wx", mode: 0o600 });
      let releasePromise: Promise<void> | undefined;
      return () => (releasePromise ??= (async () => {
        try {
          let current: unknown;
          try {
            current = JSON.parse(await readFile(home.lockFile, "utf8"));
          } catch (error: unknown) {
            if (error instanceof SyntaxError) return;
            throw error;
          }
          if (isLockRecord(current) && current.token === record.token) {
            await rm(home.lockFile);
          }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      })());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await inspectExistingLock(home.lockFile) !== "stale") {
        throw new RuntimeHomeLockedError(home.directory);
      }
      try {
        await rm(home.lockFile);
      } catch (removeError: unknown) {
        if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
      }
    }
  }
}
