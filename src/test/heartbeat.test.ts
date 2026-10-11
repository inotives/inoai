import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  HEARTBEAT_INTERVAL_MS, HealthPolicy,
  sqliteHealthProbes, probeHealth, type HealthResult, type ProbeTimer,
} from "../heartbeat/health.js";
import { inspectRuntimeHomeLock, type ProcessIdentityProbe } from "../platform/runtime-home.js";

const healthy: HealthResult = { child: "alive", lock: "live", query: "healthy" };
const identity: ProcessIdentityProbe = {
  platform: "darwin", processAlive: () => true, processStartTime: async () => "start",
};

test("lock and health probes use process identity proof without changing lock files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-"));
  const lockFile = join(directory, "inoai.lock");
  const record = JSON.stringify({ pid: 123, started_at: "start", token: "private-token" });
  try {
    await writeFile(lockFile, record);
    const input = { childPid: 123, lockFile, identity, query: async () => {} };
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
  assert.equal(policy.evaluate({ ...healthy, query: "failed" }).action, "none");
  assert.equal(policy.evaluate({ ...healthy, query: "timeout" }).action, "restart");
  assert.equal(policy.evaluate(healthy).consecutiveDatabaseFailures, 0);
  assert.equal(policy.evaluate({ ...healthy, query: "failed" }).action, "none");
  assert.equal(policy.evaluate({ ...healthy, query: "failed" }).action, "restart");
  for (const lock of ["malformed", "unverifiable", "missing", "foreign"] as const) {
    assert.equal(policy.evaluate({ ...healthy, child: "dead", lock, query: "failed" }).action, "blocked");
  }
  assert.equal(policy.evaluate({ ...healthy, child: "unverifiable" }).action, "blocked");
  assert.equal(new HealthPolicy().evaluate({ ...healthy, lock: "stale" }).action, "restart");
  assert.equal(new HealthPolicy().evaluate({ ...healthy, child: "dead" }).action, "restart");
});

test("SQLite probes have a five-second deadline and discard raw errors", async () => {
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
    let probeSignal: AbortSignal | undefined;
    const pending = probeHealth({ ...input, query: (signal) => { probeSignal = signal; return new Promise(() => {}); } });
    callbacks.forEach((callback) => callback());
    const result = await pending;
    assert.equal(result.query, "timeout");
    assert.equal(probeSignal?.aborted, true);
    assert.deepEqual(cleared.sort(), [1]);
    const failed = await probeHealth({ ...input, query: async () => { throw new Error("postgresql://secret"); } });
    assert.equal(failed.query, "failed");
    assert.equal(JSON.stringify(failed).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite probe reads the selected database with normal WAL artifacts and rejects missing or corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-sqlite-"));
  const databaseFile = join(directory, "inoai.sqlite");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE health (id INTEGER);");
    const lockFile = join(directory, "inoai.lock");
    await writeFile(lockFile, JSON.stringify({ pid: 123, started_at: "start", token: "x" }));
    assert.ok(await readFile(`${databaseFile}-wal`));
    assert.ok(await readFile(`${databaseFile}-shm`));
    assert.deepEqual(await probeHealth({ childPid: 123, lockFile, identity, ...sqliteHealthProbes(databaseFile) }), healthy);
    await assert.rejects(sqliteHealthProbes(join(directory, "missing.sqlite")).query(new AbortController().signal));
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, "invalid SQLite");
    const failed = await probeHealth({ childPid: 123, lockFile, identity, ...sqliteHealthProbes(corrupt) });
    assert.equal(failed.query, "failed");
    const controller = new AbortController();
    const pending = sqliteHealthProbes(databaseFile).query(controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
