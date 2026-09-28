import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const templates = {
  ".env": "",
  "agent.md": "# inoai\n",
  "inoai.sqlite": Buffer.alloc(0),
} as const;

export type RuntimeHome = {
  directory: string;
  envFile: string;
  agentFile: string;
  databaseFile: string;
  lockFile: string;
};

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

export async function acquireRuntimeHomeLock(home: RuntimeHome): Promise<() => Promise<void>> {
  const token = randomUUID();
  try {
    await writeFile(home.lockFile, token, { flag: "wx", mode: 0o600 });
    let releasePromise: Promise<void> | undefined;
    return () => (releasePromise ??= (async () => {
      try {
        if ((await readFile(home.lockFile, "utf8")) === token) {
          await rm(home.lockFile);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })());
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RuntimeHomeLockedError(home.directory);
    }
    throw error;
  }
}
