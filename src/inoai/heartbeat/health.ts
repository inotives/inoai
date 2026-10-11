import { Worker } from "node:worker_threads";
import {
  inspectRuntimeHomeLock, systemProcessIdentity,
  type ProcessIdentityProbe, type RuntimeHomeLockState,
} from "../agent-instance/runtime-home.js";

export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1_000;
export const DATABASE_PROBE_TIMEOUT_MS = 5_000;
export const DATABASE_FAILURE_THRESHOLD = 2;

export type HealthResult = {
  child: "alive" | "dead" | "unverifiable";
  lock: RuntimeHomeLockState;
  query: "healthy" | "failed" | "timeout";
};

export type ProbeTimer = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};
const systemTimer: ProbeTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timer: ProbeTimer): Promise<T | "failed" | "timeout"> {
  let handle: unknown;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)).catch(() => "failed" as const),
      new Promise<"timeout">((resolve) => {
        handle = timer.set(() => resolve("timeout"), DATABASE_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    controller.abort();
    timer.clear(handle);
  }
}

/** No error text, credentials, lock tokens, or database rows leave this boundary. */
export async function probeHealth(input: {
  childPid: number;
  lockFile: string;
  query(signal: AbortSignal): Promise<void>;
  identity?: ProcessIdentityProbe;
  timer?: ProbeTimer;
}): Promise<HealthResult> {
  const identity = input.identity ?? systemProcessIdentity;
  const timer = input.timer ?? systemTimer;
  let alive: boolean | undefined;
  try { alive = identity.processAlive(input.childPid); } catch { alive = undefined; }
  const [lock, query] = await Promise.all([
    inspectRuntimeHomeLock(input.lockFile, input.childPid, identity).catch(() => "unverifiable" as const),
    bounded(input.query, timer),
  ]);
  return {
    child: alive === undefined ? "unverifiable" : alive ? "alive" : "dead",
    lock,
    query: query === undefined ? "healthy" : query,
  };
}

/** Run synchronous SQLite work off the supervisor thread so the deadline can cancel it. */
export function sqliteHealthProbes(databaseFile: string) {
  return {
    query: (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("SQLite probe cancelled")); return; }
      const worker = new Worker(new URL("./sqlite-probe.js", import.meta.url), {
        workerData: { databaseFile, timeout: DATABASE_PROBE_TIMEOUT_MS },
        stdout: true, stderr: true,
      });
      const cancel = () => { void worker.terminate(); reject(new Error("SQLite probe cancelled")); };
      signal.addEventListener("abort", cancel, { once: true });
      worker.once("error", () => reject(new Error("SQLite probe failed")));
      worker.once("exit", (code) => {
        signal.removeEventListener("abort", cancel);
        if (code === 0) resolve();
        else reject(new Error("SQLite probe failed"));
      });
    }),
  };
}

export type HealthDecision = {
  healthy: boolean;
  action: "none" | "restart" | "blocked";
  consecutiveDatabaseFailures: number;
};

/** Keep one policy per child. Replace it after a child restart. */
export class HealthPolicy {
  private failures = 0;

  evaluate(result: HealthResult): HealthDecision {
    const databaseHealthy = result.query === "healthy";
    this.failures = databaseHealthy ? 0 : Math.min(this.failures + 1, DATABASE_FAILURE_THRESHOLD);
    const unsafeLock = result.lock !== "live" && result.lock !== "stale";
    const action = unsafeLock || result.child === "unverifiable" ? "blocked"
      : result.child === "dead" || result.lock === "stale" || this.failures >= DATABASE_FAILURE_THRESHOLD
        ? "restart" : "none";
    return {
      healthy: result.child === "alive" && result.lock === "live" && databaseHealthy,
      action,
      consecutiveDatabaseFailures: this.failures,
    };
  }
}
