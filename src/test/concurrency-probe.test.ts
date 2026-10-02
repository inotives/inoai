import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClaudeProbeEvent } from "../concurrency-probe.js";
import { claudeProbeArgs, claudeProbeLeftoverWarning, killProbe, probeClaudeConcurrency, probeShowsConcurrentExecution, probeShowsConcurrentStreaming } from "../concurrency-probe.js";

const threads = ["A", "B"];
const notice = (method: string, threadId: string, atMs: number, item?: Record<string, unknown>) => ({
  method, atMs, params: { threadId, ...(item ? { item } : { turn: { status: "completed" } }) },
});
const command = (id: string, exitCode?: number) => ({ type: "commandExecution", id, command: "sleep 8", exitCode });

test("probe requires overlapping completed shell work, not just early turn starts", () => {
  const starts = [notice("turn/started", "A", 0), notice("turn/started", "B", 1)];
  const parallel = [
    ...starts,
    notice("item/started", "A", 100, command("a")),
    notice("item/started", "B", 200, command("b")),
    notice("item/completed", "A", 8_100, command("a", 0)),
    notice("item/completed", "B", 8_200, command("b", 0)),
    notice("turn/completed", "A", 8_300), notice("turn/completed", "B", 8_400),
  ];
  assert.equal(probeShowsConcurrentExecution(threads, parallel), true);
  assert.equal(probeShowsConcurrentExecution(threads, [
    ...parallel.slice(0, 5),
    notice("turn/completed", "A", 8_300),
    notice("item/completed", "B", 16_200, command("b", 0)),
    notice("turn/completed", "B", 16_300),
  ]), false);
  assert.equal(probeShowsConcurrentExecution(threads, [
    ...starts, notice("turn/completed", "A", 8_100), notice("turn/completed", "B", 16_200),
  ]), false);
  assert.equal(probeShowsConcurrentExecution(threads, parallel.map((entry) => entry.method === "item/completed" && entry.params.threadId === "B"
    ? notice("item/completed", "B", entry.atMs, command("b", 1)) : entry)), false);
});

const init = (probe: number, atMs: number, session = `s${probe}`, apiKeySource: unknown = "none"): ClaudeProbeEvent =>
  ({ probe, atMs, event: { type: "system", subtype: "init", session_id: session, apiKeySource } });
const delta = (probe: number, atMs: number): ClaudeProbeEvent =>
  ({ probe, atMs, event: { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "1\n" } } } });
const result = (probe: number, atMs: number, ok = true): ClaudeProbeEvent =>
  ({ probe, atMs, event: { type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok } });

test("Claude probe passes only when both sessions stream before either completes", () => {
  const overlap = [init(0, 0), init(1, 5), delta(0, 100), delta(1, 120), delta(0, 900), result(0, 1_000), delta(1, 1_050), result(1, 1_100)];
  assert.equal(probeShowsConcurrentStreaming(overlap), true);
  // Sequential: the second session starts streaming only after the first has finished.
  assert.equal(probeShowsConcurrentStreaming([init(0, 0), delta(0, 100), result(0, 1_000), init(1, 1_010), delta(1, 1_100), result(1, 2_000)]), false);
  // One session fails.
  assert.equal(probeShowsConcurrentStreaming(overlap.map((entry) => entry.atMs === 1_100 ? result(1, 1_100, false) : entry)), false);
  // A non-subscription credential source fails the probe even when the timeline overlaps.
  assert.equal(probeShowsConcurrentStreaming([init(0, 0), init(1, 5, "s1", "ANTHROPIC_API_KEY"), ...overlap.slice(2)]), false);
  assert.equal(probeShowsConcurrentStreaming([init(0, 0), { probe: 1, atMs: 5, event: { type: "system", subtype: "init", session_id: "s1" } }, ...overlap.slice(2)]), false);
  // The two processes must be distinct sessions.
  assert.equal(probeShowsConcurrentStreaming([init(0, 0, "same"), init(1, 5, "same"), ...overlap.slice(2)]), false);
  // Missing pieces: no deltas, no result, no init, or an unknown process.
  assert.equal(probeShowsConcurrentStreaming(overlap.filter((entry) => !(entry.probe === 1 && entry.atMs === 120) && !(entry.probe === 1 && entry.atMs === 1_050))), false);
  assert.equal(probeShowsConcurrentStreaming(overlap.slice(0, -1)), false);
  assert.equal(probeShowsConcurrentStreaming(overlap.slice(1)), false);
  assert.equal(probeShowsConcurrentStreaming([...overlap, delta(2, 1_200)]), false);
});

// A fake `claude` that records its argv and cwd, creates the CLI project folder under the injected home,
// then streams a short counted list. Modes: "pass", "hang" (never finishes), "leftover" (also writes a .jsonl),
// "grandchild" (hangs after starting a detached process that keeps the CLI's stdout pipe open; its pid is recorded).
const fakeClaude = `
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const { home, mode } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  let grandchild;
  if (mode === "grandchild") {
    const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
    held.unref();
    grandchild = held.pid;
  }
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2), cwd: realpathSync(process.cwd()), stdin, pid: process.pid, grandchild }) + "\\n");
  const session = randomUUID();
  const folder = join(home, ".claude", "projects", realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(join(folder, "memory"), { recursive: true });
  if (mode === "leftover") writeFileSync(join(folder, session + ".jsonl"), "{}");
  const emit = (event) => process.stdout.write(JSON.stringify({ session_id: session, ...event }) + "\\n");
  const text = (value) => emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: value } } });
  emit({ type: "system", subtype: "init", apiKeySource: "none" });
  text("1\\n");
  if (mode === "hang" || mode === "grandchild") { setInterval(() => {}, 1000); return; }
  setTimeout(() => { text("2\\n"); emit({ type: "result", subtype: "success", is_error: false, result: "1\\n2" }); }, 800);
});
`;

async function fakeClaudeHome(mode: string) {
  const dir = await mkdtemp(join(tmpdir(), "inoai-fake-claude-probe-"));
  const home = join(dir, "home");
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  const executable = join(dir, "fake-claude.mjs");
  await writeFile(executable, `#!${process.execPath}\n${fakeClaude}`);
  await chmod(executable, 0o755);
  await writeFile(join(dir, "config.json"), JSON.stringify({ home, mode }));
  const calls = async () => (await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; stdin: string; pid: number; grandchild?: number });
  return { dir, home, executable, calls, projects: () => readdir(join(home, ".claude", "projects")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const gone = (path: string) => stat(path).then(() => false, () => true);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Claude probe runs two tool-free sessions concurrently and removes only its own empty project folder", async () => {
  const fake = await fakeClaudeHome("pass");
  try {
    await writeFile(join(fake.home, ".claude", "projects", "unrelated.txt"), "keep");
    assert.equal(await probeClaudeConcurrency({ executable: fake.executable, homeDir: fake.home }), true);
    const calls = await fake.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.argv, claudeProbeArgs);
      assert.match(call.stdin, /1 to 150/);
      assert.equal(await gone(call.cwd), true);
    }
    assert.equal(calls[0]!.cwd, calls[1]!.cwd);
    assert.deepEqual(await fake.projects(), ["unrelated.txt"]);
  } finally {
    await fake.cleanup();
  }
});

test("Claude probe times out, kills both sessions, and still cleans up", async () => {
  const fake = await fakeClaudeHome("hang");
  try {
    const started = Date.now();
    assert.equal(await probeClaudeConcurrency({ executable: fake.executable, homeDir: fake.home, timeoutMs: 1_500 }), false);
    assert.ok(Date.now() - started < 10_000);
    const calls = await fake.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(alive(call.pid), false);
      assert.equal(await gone(call.cwd), true);
    }
    assert.deepEqual(await fake.projects(), []);
  } finally {
    await fake.cleanup();
  }
});

test("Claude probe leaves a project folder holding a session file and warns without its path", async (t) => {
  const fake = await fakeClaudeHome("leftover");
  const warn = t.mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await probeClaudeConcurrency({ executable: fake.executable, homeDir: fake.home }), true);
    const [folder] = await fake.projects();
    assert.ok(folder);
    assert.equal((await readdir(join(fake.home, ".claude", "projects", folder))).filter((name) => name.endsWith(".jsonl")).length, 2);
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [[claudeProbeLeftoverWarning]]);
    assert.doesNotMatch(claudeProbeLeftoverWarning, /\/|home|Users/);
  } finally {
    await fake.cleanup();
  }
});

test("Claude probe returns within its bound when a leftover process keeps the CLI's stdout open", async () => {
  const fake = await fakeClaudeHome("grandchild");
  const grandchildren: number[] = [];
  try {
    const started = Date.now();
    assert.equal(await probeClaudeConcurrency({ executable: fake.executable, homeDir: fake.home, timeoutMs: 1_500 }), false);
    // Timeout plus the two-second exit grace, with margin; without the bound this waits for the 60 s grandchild.
    assert.ok(Date.now() - started < 6_000);
    const calls = await fake.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      grandchildren.push(call.grandchild!);
      assert.equal(alive(call.pid), false);
      assert.equal(alive(call.grandchild!), true);
      assert.equal(await gone(call.cwd), true);
    }
    assert.deepEqual(await fake.projects(), []);
  } finally {
    // The probe does not own the CLI's descendants; the test kills its own by recorded pid.
    for (const pid of grandchildren) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    await fake.cleanup();
  }
});

test("Claude probe kill guard never signals a child without a pid", () => {
  const fakeChild = (pid: number | undefined, exitCode: number | null = null) => {
    const signals: unknown[] = [];
    return { child: { pid, exitCode, signalCode: null, kill: (signal: unknown) => { signals.push(signal); return true; } } as unknown as ChildProcess, signals };
  };
  const unspawned = fakeChild(undefined);
  killProbe(unspawned.child);
  assert.deepEqual(unspawned.signals, []);
  const exited = fakeChild(4_242, 0);
  killProbe(exited.child);
  assert.deepEqual(exited.signals, []);
  const running = fakeChild(4_242);
  killProbe(running.child);
  assert.deepEqual(running.signals, ["SIGKILL"]);
});

// Runs in a detached child (its own process group), so a regressed kill guard could not signal the test runner.
test("Claude probe returns false when the CLI cannot be spawned", async () => {
  const fake = await fakeClaudeHome("pass");
  try {
    const script = join(fake.dir, "spawn-failure.mjs");
    const probeModule = new URL("../concurrency-probe.js", import.meta.url).href;
    await writeFile(script, `import { probeClaudeConcurrency } from ${JSON.stringify(probeModule)};
process.stdout.write(JSON.stringify(await probeClaudeConcurrency({ executable: ${JSON.stringify(join(fake.dir, "missing-claude"))}, homeDir: ${JSON.stringify(fake.home)} })));`);
    const child = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(output, "false");
    assert.deepEqual(await fake.projects(), []);
  } finally {
    await fake.cleanup();
  }
});
