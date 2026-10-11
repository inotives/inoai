import type { Pool, QueryConfig } from "pg";
import { agentInstanceLeaseFresh } from "../persistence/postgres-lease.js";
import {
  inspectRuntimeHomeLock, systemProcessIdentity,
  type ProcessIdentityProbe, type RuntimeHomeLockState,
} from "../platform/runtime-home.js";

export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1_000;
export const DATABASE_PROBE_TIMEOUT_MS = 5_000;
export const DATABASE_FAILURE_THRESHOLD = 2;

export type HealthResult = {
  child: "alive" | "dead" | "unverifiable";
  lock: RuntimeHomeLockState;
  lease: "fresh" | "failed" | "timeout";
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

async function bounded<T>(work: () => Promise<T>, timer: ProbeTimer): Promise<T | "failed" | "timeout"> {
  let handle: unknown;
  try {
    return await Promise.race([
      Promise.resolve().then(work).catch(() => "failed" as const),
      new Promise<"timeout">((resolve) => {
        handle = timer.set(() => resolve("timeout"), DATABASE_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    timer.clear(handle);
  }
}

/** No error text, credentials, lock tokens, or database rows leave this boundary. */
export async function probeHealth(input: {
  childPid: number;
  lockFile: string;
  leaseFresh(): Promise<boolean>;
  query(): Promise<void>;
  identity?: ProcessIdentityProbe;
  timer?: ProbeTimer;
}): Promise<HealthResult> {
  const identity = input.identity ?? systemProcessIdentity;
  const timer = input.timer ?? systemTimer;
  let alive: boolean | undefined;
  try { alive = identity.processAlive(input.childPid); } catch { alive = undefined; }
  const [lock, lease, query] = await Promise.all([
    inspectRuntimeHomeLock(input.lockFile, input.childPid, identity).catch(() => "unverifiable" as const),
    bounded(input.leaseFresh, timer),
    bounded(input.query, timer),
  ]);
  return {
    child: alive === undefined ? "unverifiable" : alive ? "alive" : "dead",
    lock,
    lease: lease === true ? "fresh" : lease === "timeout" ? "timeout" : "failed",
    query: query === undefined ? "healthy" : query,
  };
}

/** Uses the same pool boundary as the operational store. Does not mutate ownership. */
export function postgresHealthProbes(pool: Pick<Pool, "query">, agentInstanceId: string) {
  return {
    leaseFresh: () => agentInstanceLeaseFresh(pool, agentInstanceId),
    query: async (): Promise<void> => {
      const query: QueryConfig & { query_timeout: number } = {
        text: "SELECT 1", query_timeout: DATABASE_PROBE_TIMEOUT_MS,
      };
      await pool.query(query);
    },
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
    const databaseHealthy = result.lease === "fresh" && result.query === "healthy";
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
