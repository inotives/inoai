import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../app/application.js";
import { HEARTBEAT_INTERVAL_MS, type HealthResult } from "../heartbeat/health.js";
import { HeartbeatSupervisor, localHeartbeatLog, spawnInoai, type SupervisorChild, type SupervisorDependencies, type SupervisorEvent } from "../heartbeat/supervisor.js";

const healthy: HealthResult = { child: "alive", lock: "live", lease: "fresh", query: "healthy" };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Clock {
  time = 0;
  sequence = 0;
  timers = new Map<number, { at: number; callback(): void }>();
  now = () => this.time;
  set = (callback: () => void, milliseconds: number) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + milliseconds, callback });
    return id;
  };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  async advance(milliseconds: number) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
class Child extends EventEmitter implements SupervisorChild {
  signals: string[] = [];
  autoExit = true;
  constructor(readonly pid: number) { super(); }
  kill(signal: "SIGTERM" | "SIGKILL") {
    this.signals.push(signal);
    if (this.autoExit) this.emit("exit");
    return true;
  }
}
function fixture(overrides: Partial<SupervisorDependencies> = {}) {
  const clock = new Clock();
  const children: Child[] = [];
  const logs: Array<{ event: SupervisorEvent; error: boolean }> = [];
  let result = healthy;
  let probes = 0;
  const supervisor = new HeartbeatSupervisor({ clock,
    spawn: () => { const child = new Child(children.length + 1); children.push(child); return child; },
    probe: async () => { probes++; return result; },
    log: async (event, error = false) => { logs.push({ event, error }); }, ...overrides });
  supervisor.start();
  return { supervisor, clock, children, logs, setResult: (value: HealthResult) => { result = value; }, probes: () => probes };
}

test("healthy hourly operation owns one child and stop cancels future work", async () => {
  const f = fixture();
  await flush();
  f.supervisor.start();
  await f.clock.advance(HEARTBEAT_INTERVAL_MS - 1);
  assert.equal(f.probes(), 0);
  await f.clock.advance(1);
  assert.equal(f.probes(), 1);
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(f.children.length, 1);
  assert.equal(f.logs.filter((log) => log.event === "healthy").length, 2);
  assert.equal(await f.supervisor.stop(), 0);
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(f.children.length, 1);
});

test("database restart tolerates one failure and resets policy for replacement", async () => {
  const f = fixture();
  await flush();
  f.setResult({ ...healthy, query: "failed" });
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(f.children.length, 1);
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(f.children.length, 2);
  await f.supervisor.stop();
});

test("restart waits ten seconds then kills and waits for confirmed exit", async () => {
  const f = fixture();
  await flush();
  f.children[0].autoExit = false;
  f.setResult({ ...healthy, lock: "stale" });
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  await f.clock.advance(9_999);
  assert.equal(f.children.length, 1);
  await f.clock.advance(1);
  assert.deepEqual(f.children[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.children.length, 1);
  f.children[0].emit("exit");
  await flush();
  assert.equal(f.children.length, 2);
  await f.supervisor.stop();
});

test("signal shutdown escalates without spawning a replacement", async () => {
  const f = fixture();
  await flush();
  f.children[0].autoExit = false;
  const stopped = f.supervisor.stop();
  await flush();
  await f.clock.advance(10_000);
  assert.deepEqual(f.children[0].signals, ["SIGTERM", "SIGKILL"]);
  f.children[0].emit("exit");
  assert.equal(await stopped, 0);
  assert.equal(f.children.length, 1);
});

test("child exits wait ten seconds and permit only three retries in five minutes", async () => {
  const f = fixture();
  await flush();
  for (let i = 0; i < 4; i++) {
    f.children.at(-1)!.emit("exit");
    await flush();
    await f.clock.advance(9_999);
    assert.equal(f.children.length, i + 1);
    await f.clock.advance(1);
  }
  assert.equal(f.children.length, 4);
  assert.equal(await f.supervisor.finished, 1);
  assert.ok(f.logs.some((log) => log.event === "retry-limit" && log.error));
  assert.equal(f.clock.timers.size, 0);
});

test("retry window expires and stop during retry delay cancels restart", async () => {
  const f = fixture();
  await flush();
  for (let i = 0; i < 5; i++) {
    f.children.at(-1)!.emit("exit");
    await flush();
    await f.clock.advance(10_000);
    await f.clock.advance(300_000);
  }
  assert.equal(f.children.length, 6);
  f.children.at(-1)!.emit("exit");
  await flush();
  await f.supervisor.stop();
  await f.clock.advance(10_000);
  assert.equal(f.children.length, 6);
});

test("unsafe health stops and never starts another child", async () => {
  const f = fixture();
  await flush();
  f.setResult({ ...healthy, lock: "malformed" });
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(await f.supervisor.finished, 1);
  assert.equal(f.children.length, 1);
  assert.ok(f.logs.some((log) => log.event === "health-blocked"));
});

test("shutdown during pending health check prevents restart", async () => {
  let resolve!: (result: HealthResult) => void;
  const f = fixture({ probe: () => new Promise((done) => { resolve = done; }) });
  await flush();
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  const stopped = f.supervisor.stop();
  resolve({ ...healthy, lock: "stale" });
  assert.equal(await stopped, 0);
  assert.equal(f.children.length, 1);
});

test("raw spawn errors and environment values never enter local logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-log-"));
  const secret = "postgresql://private:password@server/db";
  try {
    const log = localHeartbeatLog(directory);
    let logged!: () => void;
    const failed = new Promise<void>((resolve) => { logged = resolve; });
    const f = fixture({ log: async (event, error) => { await log(event, error); if (event === "spawn-failed") logged(); },
      spawn: () => { throw new Error(secret); } });
    await failed;
    await f.supervisor.stop();
    const contents = await readFile(join(directory, "heartbeat-error.log"), "utf8");
    assert.match(contents, /spawn-failed/);
    assert.equal(contents.includes(secret), false);
    assert.equal(contents.includes("password"), false);
    assert.match(await readFile(join(directory, "heartbeat.log"), "utf8"), /stopped/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("heartbeat CLI uses the existing connect directory parser", async () => {
  const calls: unknown[] = [];
  const heartbeat = async (...args: unknown[]) => { calls.push(args); };
  await run(["heartbeat", "--connect-dir", ".inoai-connect-test"], undefined, undefined, { heartbeat });
  assert.deepEqual(calls, [[process.cwd(), ".inoai-connect-test"]]);
  await assert.rejects(run(["heartbeat", "--bad"], undefined, undefined, { heartbeat }), /Usage/);
});

test("child execution uses Node and the compiled executable without a shell", () => {
  let command: string | undefined;
  let values: string[] = [];
  const child = new Child(1);
  assert.equal(spawnInoai(".inoai-connect-test", "/tmp/project", (executable, args, options) => {
    command = executable;
    values = args;
    assert.deepEqual(options, { cwd: "/tmp/project", shell: false, stdio: "ignore" });
    return child;
  }), child);
  assert.equal(command, process.execPath);
  assert.ok(values[0].endsWith("/dist/index.js"));
  assert.deepEqual(values.slice(1), ["--connect-dir", ".inoai-connect-test"]);
});

test("synchronous spawn failures use the same bounded retry policy", async () => {
  let attempts = 0;
  const f = fixture({ spawn: () => { attempts++; throw new Error("private-environment-value"); } });
  await flush();
  await f.clock.advance(40_000);
  assert.equal(attempts, 4);
  assert.equal(await f.supervisor.finished, 1);
  assert.equal(f.logs.filter((entry) => entry.event === "spawn-failed").length, 4);
  assert.equal(JSON.stringify(f.logs).includes("private-environment-value"), false);
});

test("an asynchronous spawn error without a PID schedules one retry", async () => {
  const failed = new EventEmitter() as EventEmitter & SupervisorChild;
  failed.kill = () => { throw new Error("Cannot signal an unspawned child"); };
  let starts = 0;
  const replacement = new Child(2);
  const f = fixture({ spawn: () => ++starts === 1 ? failed : replacement });
  await flush();
  failed.emit("error", new Error("postgresql://private"));
  await flush();
  await f.clock.advance(9_999);
  assert.equal(starts, 1);
  await f.clock.advance(1);
  assert.equal(starts, 2);
  await f.supervisor.stop();
  assert.deepEqual(replacement.signals, ["SIGTERM"]);
});

test("stop during restart termination waits for exit and cancels replacement", async () => {
  const f = fixture();
  await flush();
  f.children[0].autoExit = false;
  f.setResult({ ...healthy, lock: "stale" });
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  const stopped = f.supervisor.stop();
  await f.clock.advance(10_000);
  f.children[0].emit("exit");
  assert.equal(await stopped, 0);
  assert.equal(f.children.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("an unexpected probe failure shuts down with only a fixed error record", async () => {
  const f = fixture({ probe: async () => { throw new Error("postgresql://private-environment-value"); } });
  await flush();
  await f.clock.advance(HEARTBEAT_INTERVAL_MS);
  assert.equal(await f.supervisor.finished, 1);
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  assert.ok(f.logs.some((entry) => entry.event === "supervisor-failed" && entry.error));
  assert.equal(JSON.stringify(f.logs).includes("private-environment-value"), false);
});
