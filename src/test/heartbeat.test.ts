import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Pool } from "pg";
import {
  DATABASE_PROBE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, HealthPolicy,
  postgresHealthProbes, probeHealth, type HealthResult, type ProbeTimer,
} from "../heartbeat/health.js";
import { inspectRuntimeHomeLock, type ProcessIdentityProbe } from "../platform/runtime-home.js";

const healthy: HealthResult = { child: "alive", lock: "live", lease: "fresh", query: "healthy" };
const identity: ProcessIdentityProbe = {
  platform: "darwin", processAlive: () => true, processStartTime: async () => "start",
};

test("lock and health probes use process identity proof without changing lock files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-"));
  const lockFile = join(directory, "inoai.lock");
  const record = JSON.stringify({ pid: 123, started_at: "start", token: "private-token" });
  try {
    await writeFile(lockFile, record);
    const input = { childPid: 123, lockFile, identity, leaseFresh: async () => true, query: async () => {} };
    assert.deepEqual(await probeHealth(input), healthy);
    assert.equal(await inspectRuntimeHomeLock(lockFile, 456, identity), "foreign");
    assert.equal(await inspectRuntimeHomeLock(lockFile, 123, { ...identity, processStartTime: async () => "reused" }), "stale");
    assert.equal(await inspectRuntimeHomeLock(lockFile, 123, { ...identity, processStartTime: async () => undefined }), "unverifiable");
    assert.equal(await inspectRuntimeHomeLock(lockFile, 123, { ...identity, processAlive: () => undefined }), "unverifiable");
    assert.equal(await inspectRuntimeHomeLock(lockFile, 123, { ...identity, platform: "linux" }), "unverifiable");
    const dead = await probeHealth({ ...input, identity: { ...identity, processAlive: () => false } });
    assert.equal(dead.child, "dead");
    assert.equal(dead.lock, "stale");
    assert.equal(new HealthPolicy().evaluate(dead).action, "restart");
    assert.equal(await readFile(lockFile, "utf8"), record);
    for (const malformed of ["{", "123", JSON.stringify({ pid: 123 }), JSON.stringify({ pid: -1, started_at: "start", token: "x" })]) {
      await writeFile(lockFile, malformed);
      assert.equal((await probeHealth(input)).lock, "malformed");
      assert.equal(await readFile(lockFile, "utf8"), malformed);
    }
    await rm(lockFile);
    assert.equal(await inspectRuntimeHomeLock(lockFile, 123, identity), "missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy tolerates one failure, counts mixed failures, and resets after recovery", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 3_600_000);
  const policy = new HealthPolicy();
  assert.deepEqual(policy.evaluate(healthy), { healthy: true, action: "none", consecutiveDatabaseFailures: 0 });
  assert.equal(policy.evaluate({ ...healthy, lease: "failed" }).action, "none");
  assert.equal(policy.evaluate({ ...healthy, query: "timeout" }).action, "restart");
  assert.equal(policy.evaluate(healthy).consecutiveDatabaseFailures, 0);
  assert.equal(policy.evaluate({ ...healthy, query: "failed" }).action, "none");
  assert.equal(policy.evaluate({ ...healthy, query: "failed" }).action, "restart");
  for (const lock of ["malformed", "unverifiable", "missing", "foreign"] as const) {
    assert.equal(policy.evaluate({ ...healthy, child: "dead", lock, lease: "failed" }).action, "blocked");
  }
  assert.equal(policy.evaluate({ ...healthy, child: "unverifiable" }).action, "blocked");
  assert.equal(new HealthPolicy().evaluate({ ...healthy, lock: "stale" }).action, "restart");
  assert.equal(new HealthPolicy().evaluate({ ...healthy, child: "dead" }).action, "restart");
});

test("database and lease probes have a five-second deadline and discard raw errors", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  const timer: ProbeTimer = {
    set(callback, milliseconds) {
      assert.equal(milliseconds, 5_000);
      callbacks.push(callback);
      return callbacks.length;
    },
    clear(handle) { cleared.push(handle); },
  };
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-"));
  const lockFile = join(directory, "inoai.lock");
  try {
    await writeFile(lockFile, JSON.stringify({ pid: 123, started_at: "start", token: "x" }));
    const input = { childPid: 123, lockFile, identity, timer };
    const pending = probeHealth({ ...input, leaseFresh: () => new Promise(() => {}), query: () => new Promise(() => {}) });
    callbacks.forEach((callback) => callback());
    const result = await pending;
    assert.equal(result.query, "timeout");
    assert.equal(result.lease, "timeout");
    assert.deepEqual(cleared.sort(), [1, 2]);
    const failed = await probeHealth({ ...input, leaseFresh: async () => false, query: async () => { throw new Error("postgresql://secret"); } });
    assert.equal(failed.lease, "failed");
    assert.equal(failed.query, "failed");
    assert.equal(JSON.stringify(failed).includes("secret"), false);
    const leaseError = await probeHealth({ ...input, leaseFresh: async () => { throw new Error("password"); }, query: async () => {} });
    assert.equal(leaseError.lease, "failed");
    assert.equal(leaseError.query, "healthy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL probes read current lease authority and run a bounded lightweight query", async () => {
  const calls: Array<{ text: string; values?: unknown[]; query_timeout?: number }> = [];
  let fresh = true;
  const pool = { async query(query: string | { text: string; query_timeout?: number }, values?: unknown[]) {
    const call = typeof query === "string" ? { text: query, values } : query;
    calls.push(call);
    return { rows: [{ fresh }] };
  } } as unknown as Pool;
  const probes = postgresHealthProbes(pool, "agent-test");
  assert.equal(await probes.leaseFresh(), true);
  fresh = false;
  assert.equal(await probes.leaseFresh(), false);
  assert.deepEqual(calls[0].values, ["agent-test"]);
  assert.match(calls[0].text, /expires_at > now\(\)/);
  assert.match(calls[0].text, /owner_token IS NOT NULL/);
  assert.match(calls[0].text, /disabled_at IS NULL/);
  await probes.query();
  assert.deepEqual(calls[2], { text: "SELECT 1", query_timeout: DATABASE_PROBE_TIMEOUT_MS });
});
