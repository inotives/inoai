import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeFailure, reviewInstructions } from "../agent-runtime.js";
import type { AgentRuntime } from "../agent-runtime.js";
import { ClaudeRuntime, claudeReviewLeftoverWarning } from "../claude-runtime.js";
import type { CodexAppServer } from "../codex-app-server.js";
import { CodexRuntime } from "../codex-runtime.js";
import { OpenCodeRuntime } from "../opencode-runtime.js";

// "folder": what the fake CLI leaves in ~/.claude/projects/<encoded cwd>/ (the real CLI creates none under --system-prompt).
type Scenario = { lines?: unknown[]; exit?: number; hang?: boolean; onSigint?: unknown[]; folder?: "none" | "memory" | "jsonl" };
type Call = { argv: string[]; cwd: string; stdin: string; pid: number };

// A fake `claude` that records argv, cwd, and stdin, optionally writes its project folder, then replays stream-json lines.
const fakeScript = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const calls = join(dir, "calls.jsonl");
const { home, scenario } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const folder = join(home, ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
if (scenario.folder === "memory" || scenario.folder === "jsonl") mkdirSync(join(folder, "memory"), { recursive: true });
if (scenario.folder === "jsonl") writeFileSync(join(folder, "session.jsonl"), "{}");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  appendFileSync(calls, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, pid: process.pid }) + "\\n");
  const emit = (events) => { for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n"); };
  emit(scenario.lines ?? []);
  if (scenario.onSigint) process.on("SIGINT", () => { emit(scenario.onSigint); process.exit(0); });
  if (scenario.hang || scenario.onSigint) setInterval(() => {}, 1000);
  else process.exitCode = scenario.exit ?? 0;
});
`;

async function fakeClaude(scenario: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), "inoai-fake-claude-review-"));
  const home = join(dir, "home");
  const projects = join(home, ".claude", "projects");
  await mkdir(projects, { recursive: true });
  const executable = join(dir, "fake-claude.mjs");
  await writeFile(executable, `#!${process.execPath}\n${fakeScript}`);
  await chmod(executable, 0o755);
  const setScenario = (next: Scenario) => writeFile(join(dir, "config.json"), JSON.stringify({ home, scenario: next }));
  await setScenario(scenario);
  const calls = async (): Promise<Call[]> => (await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
  const reset = () => rm(join(dir, "calls.jsonl"), { force: true });
  return { dir, home, executable, setScenario, calls, reset, projects: () => readdir(projects), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const init = { type: "system", subtype: "init", session_id: "s", tools: [], mcp_servers: [], apiKeySource: "none" };
const text = (value: string) => ({ type: "assistant", message: { content: [{ type: "text", text: value }] } });
const success = (value: string) => ({ type: "result", subtype: "success", is_error: false, result: value, permission_denials: [] });
const aborted = { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" };
const answer = "```json\n{\"recap\":\"r\",\"actions\":[]}\n```";
const gone = (path: string) => stat(path).then(() => false, () => true);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function rejection(promise: Promise<unknown>): Promise<RuntimeFailure> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RuntimeFailure, `expected RuntimeFailure, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the review to fail");
}

// Points os.tmpdir() at a fresh folder so a test can see every review cwd the runtime creates, even one never handed to a CLI.
async function isolatedTmp(): Promise<{ entries: () => Promise<string[]>; restore: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "inoai-review-tmp-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return {
    entries: () => readdir(dir),
    restore: async () => {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Claude review runs one text-only throwaway CLI call in a fresh cwd and returns the final result", async () => {
  const fake = await fakeClaude({ lines: [init, text(answer), success(answer)], folder: "memory" });
  try {
    await writeFile(join(fake.home, ".claude", "projects", "unrelated.txt"), "keep");
    const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home });
    assert.equal(await runtime.review("review prompt"), answer);
    assert.equal(await runtime.review("second prompt"), answer);
    const [first, second] = await fake.calls();
    assert.deepEqual(first!.argv, [
      "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--permission-prompts", "none", "--tools", "", "--strict-mcp-config", "--safe-mode",
      "--system-prompt", reviewInstructions,
    ]);
    for (const flag of ["--append-system-prompt", "--resume", "--session-id", "--dangerously-skip-permissions", "--permission-mode", "--allowedTools"]) {
      assert.equal(first!.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), false, flag);
    }
    assert.equal(first!.stdin, "review prompt");
    assert.equal(second!.stdin, "second prompt");
    assert.notEqual(first!.cwd, second!.cwd);
    assert.match(first!.cwd, /inoai-claude-review-/);
    assert.equal(await gone(first!.cwd), true);
    assert.equal(await gone(second!.cwd), true);
    assert.deepEqual(await fake.projects(), ["unrelated.txt"]);
    // Reviews never create or touch an Agent Session.
    await assert.rejects(runtime.runTurn("s", "question").next(), /started or resumed first/);

    await fake.reset();
    const modelled = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, model: "haiku" });
    assert.equal(await modelled.review("p"), answer);
    assert.deepEqual((await fake.calls())[0]!.argv.slice(-1), ["--model=haiku"]);
    assert.equal((await fake.calls())[0]!.argv.filter((arg) => arg.startsWith("--model")).length, 1);
  } finally { await fake.cleanup(); }
});

test("Claude review fails closed and replay-safe on any unsafe init or tool signal, killing the CLI at once", async () => {
  const fake = await fakeClaude({});
  try {
    const leaked = "leaked review text";
    const cases: Array<[string, unknown[], RuntimeFailure["kind"], boolean]> = [
      ["memory paths", [{ ...init, memory_paths: { auto: "/home/.claude/projects/x/memory/" } }], "uncertain", true],
      ["tools", [{ ...init, tools: ["Bash"] }], "uncertain", true],
      ["missing tools", [{ ...init, tools: undefined }], "uncertain", true],
      ["MCP servers", [{ ...init, mcp_servers: [{ name: "server", status: "connected" }] }], "uncertain", true],
      ["missing MCP servers", [{ ...init, mcp_servers: undefined }], "uncertain", true],
      ["API key", [{ ...init, apiKeySource: "ANTHROPIC_API_KEY" }], "authentication", true],
      ["missing API key source", [{ ...init, apiKeySource: undefined }], "authentication", true],
      ["tool use", [init, { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }], "uncertain", true],
      ["permission denied", [init, { type: "system", subtype: "permission_denied" }], "uncertain", true],
      ["result denials", [init, text(leaked), { ...success(leaked), permission_denials: [{ tool_name: "Bash" }] }], "uncertain", false],
      ["no init", [text(leaked), success(leaked)], "uncertain", false],
    ];
    for (const [name, lines, kind, hang] of cases) {
      await fake.reset();
      // A hanging fake settles only if the runtime kills it on the offending event.
      await fake.setScenario({ lines: hang ? [...lines, text(leaked), success(leaked)] : lines, hang });
      const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, reviewTimeoutMs: 30_000 });
      const started = Date.now();
      const error = await rejection(runtime.review("p"));
      assert.equal(error.kind, kind, name);
      assert.equal(error.replaySafe, true, name);
      assert.ok(Date.now() - started < 10_000, name);
      const [call] = await fake.calls();
      assert.equal(alive(call!.pid), false, name);
      assert.equal(await gone(call!.cwd), true, name);
    }
    // Empty memory_paths reports none.
    await fake.reset();
    await fake.setScenario({ lines: [{ ...init, memory_paths: {} }, success("ok")] });
    assert.equal(await new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home }).review("p"), "ok");
  } finally { await fake.cleanup(); }
});

test("Claude review times out, kills the CLI, and cleans up", async () => {
  const fake = await fakeClaude({ hang: true, lines: [init, text("thinking")], folder: "memory" });
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, reviewTimeoutMs: 300 });
    const error = await rejection(runtime.review("p"));
    assert.equal(error.kind, "timed_out");
    assert.equal(error.replaySafe, true);
    const [call] = await fake.calls();
    assert.equal(alive(call!.pid), false);
    assert.equal(await gone(call!.cwd), true);
    assert.deepEqual(await fake.projects(), []);
  } finally { await fake.cleanup(); }
});

test("Claude review abort sends SIGINT and is cancelled; a pre-aborted review never spawns", async () => {
  const fake = await fakeClaude({ lines: [init], onSigint: [aborted] });
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home });
    const controller = new AbortController();
    const pending = rejection(runtime.review("p", { signal: controller.signal }));
    await until(async () => (await fake.calls()).length === 1);
    controller.abort();
    const error = await pending;
    assert.equal(error.kind, "cancelled");
    assert.equal(error.replaySafe, true);
    const [call] = await fake.calls();
    assert.equal(alive(call!.pid), false);
    assert.equal(await gone(call!.cwd), true);

    await fake.reset();
    const early = await rejection(runtime.review("p", { signal: AbortSignal.abort() }));
    assert.equal(early.kind, "cancelled");
    assert.deepEqual(await fake.calls(), []);
  } finally { await fake.cleanup(); }
});

test("Claude review aborted while its cwd is being created is cancelled before the CLI spawns", async () => {
  const fake = await fakeClaude({ lines: [init], hang: true });
  const tmp = await isolatedTmp();
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, reviewTimeoutMs: 30_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = rejection(runtime.review("p", { signal: controller.signal }));
    controller.abort();
    const error = await pending;
    assert.equal(error.kind, "cancelled");
    assert.equal(error.replaySafe, true);
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await fake.calls(), []);
    assert.deepEqual(await tmp.entries(), []);
  } finally { await tmp.restore(); await fake.cleanup(); }
});

test("Claude close stops a running review, and a review closed while its cwd is created never spawns", async () => {
  const fake = await fakeClaude({ lines: [init, text("thinking")], hang: true });
  const tmp = await isolatedTmp();
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, reviewTimeoutMs: 30_000 });
    const started = Date.now();
    const pending = rejection(runtime.review("p"));
    await until(async () => (await fake.calls()).length === 1);
    await runtime.close();
    const error = await pending;
    assert.equal(error.replaySafe, true);
    assert.ok(Date.now() - started < 10_000);
    const [call] = await fake.calls();
    assert.equal(alive(call!.pid), false);
    assert.equal(await gone(call!.cwd), true);

    await fake.reset();
    const racing = new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home, reviewTimeoutMs: 30_000 });
    const raced = rejection(racing.review("p"));
    await racing.close();
    assert.equal((await raced).kind, "pre_start");
    assert.deepEqual(await fake.calls(), []);
    assert.deepEqual(await tmp.entries(), []);
  } finally { await tmp.restore(); await fake.cleanup(); }
});

test("Claude review leaves a project folder holding a session file and warns without its path", async (t) => {
  const fake = await fakeClaude({ lines: [init, success("ok")], folder: "jsonl" });
  const warn = t.mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await new ClaudeRuntime({ executable: fake.executable, homeDir: fake.home }).review("p"), "ok");
    assert.equal((await fake.projects()).length, 1);
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [[claudeReviewLeftoverWarning]]);
    assert.doesNotMatch(claudeReviewLeftoverWarning, /\/|home|Users/);
  } finally { await fake.cleanup(); }
});

test("Claude review that cannot spawn, or runs after close, is a replay-safe pre-start", async () => {
  const runtime = new ClaudeRuntime({ executable: join(tmpdir(), "inoai-missing-claude-cli") });
  const error = await rejection(runtime.review("p"));
  assert.equal(error.kind, "pre_start");
  assert.equal(error.replaySafe, true);
  await runtime.close();
  assert.equal((await rejection(runtime.review("p"))).kind, "pre_start");
});

class FakeServer {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closes = 0;
  rejectThreadStart = false;
  private notices = new Set<(method: string, params: unknown) => void>();
  private failures = new Set<(error: Error) => void>();
  health(): { state: "ready" } { return { state: "ready" }; }
  async close(): Promise<void> { this.closes++; }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "thread/start") {
      if (this.rejectThreadStart) throw new Error("Codex request failed");
      return { thread: { id: "review-thread" } };
    }
    if (method === "turn/start") return { turn: { id: "review-turn" } };
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected ${method}`);
  }
  addNotificationListener(listener: (method: string, params: unknown) => void): () => void { this.notices.add(listener); return () => this.notices.delete(listener); }
  addFailureListener(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  emit(method: string, params: unknown): void { for (const listener of this.notices) listener(method, params); }
  client(): CodexAppServer { return this as unknown as CodexAppServer; }
  async started(): Promise<void> { await until(async () => this.sent.some((entry) => entry.method === "turn/start")); }
}

// Owner decision D2 keeps Codex reviews off by default; these tests exercise the gated implementation directly.
const reviewingCodex = (server: CodexAppServer, idleTimeoutMs = 300_000, reviewTimeoutMs = 600_000) => new CodexRuntime(server, idleTimeoutMs, reviewTimeoutMs, true);

const item = (type: string, extra: Record<string, unknown> = {}) => ({ threadId: "review-thread", turnId: "review-turn", item: { type, ...extra } });

test("Codex review uses an ephemeral read-only thread with approval never and returns the final agent message", async () => {
  const fake = new FakeServer();
  const runtime = reviewingCodex(fake.client());
  const pending = runtime.review!("review prompt");
  await fake.started();
  fake.emit("item/completed", { threadId: "other-thread", turnId: "review-turn", item: { type: "agentMessage", text: "wrong" } });
  fake.emit("item/started", item("userMessage"));
  fake.emit("item/started", item("reasoning"));
  fake.emit("item/completed", item("agentMessage", { text: answer }));
  fake.emit("turn/completed", { threadId: "review-thread", turn: { id: "review-turn", status: "completed" } });
  assert.equal(await pending, answer);
  const [thread, turn] = fake.sent;
  const cwd = thread!.params.cwd as string;
  assert.match(cwd, /inoai-codex-review-/);
  assert.deepEqual(thread, { method: "thread/start", params: { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, developerInstructions: reviewInstructions } });
  assert.deepEqual(turn, { method: "turn/start", params: { threadId: "review-thread", cwd, input: [{ type: "text", text: "review prompt" }], sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" } });
  assert.equal(fake.sent.length, 2);
  assert.equal(await gone(cwd), true);
  // The review thread is never an Agent Session.
  await assert.rejects(runtime.runTurn("review-thread", "question").next(), /started or resumed first/);
});

test("Codex review fails closed on any tool item and interrupts its turn", async () => {
  for (const type of ["commandExecution", "fileChange", "mcpToolCall", "webSearch"]) {
    const fake = new FakeServer();
    const pending = rejection(reviewingCodex(fake.client()).review!("p"));
    await fake.started();
    fake.emit("item/started", item(type));
    const error = await pending;
    assert.equal(error.kind, "uncertain", type);
    assert.equal(error.replaySafe, true, type);
    assert.deepEqual(fake.sent.at(-1), { method: "turn/interrupt", params: { threadId: "review-thread", turnId: "review-turn" } });
  }
});

test("Codex review times out or aborts by interrupting its turn, never closing the shared app-server", async () => {
  const timed = new FakeServer();
  const timeout = await rejection(reviewingCodex(timed.client(), 300_000, 200).review!("p"));
  assert.equal(timeout.kind, "timed_out");
  assert.equal(timeout.replaySafe, true);
  assert.equal(timed.sent.at(-1)?.method, "turn/interrupt");
  assert.equal(timed.closes, 0);

  const fake = new FakeServer();
  const controller = new AbortController();
  const pending = rejection(reviewingCodex(fake.client()).review!("p", { signal: controller.signal }));
  await fake.started();
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.replaySafe, true);
  assert.deepEqual(fake.sent.at(-1), { method: "turn/interrupt", params: { threadId: "review-thread", turnId: "review-turn" } });
  assert.equal(fake.closes, 0);

  const early = new FakeServer();
  assert.equal((await rejection(reviewingCodex(early.client()).review!("p", { signal: AbortSignal.abort() }))).kind, "cancelled");
  assert.deepEqual(early.sent, []);
});

test("Codex review aborted while its cwd is being created is cancelled before any thread or turn starts", async () => {
  const tmp = await isolatedTmp();
  try {
    const fake = new FakeServer();
    const controller = new AbortController();
    const started = Date.now();
    const pending = rejection(reviewingCodex(fake.client(), 300_000, 30_000).review!("p", { signal: controller.signal }));
    controller.abort();
    const error = await pending;
    assert.equal(error.kind, "cancelled");
    assert.equal(error.replaySafe, true);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(fake.sent.some((entry) => entry.method === "turn/start"), false);
    assert.deepEqual(fake.sent, []);
    assert.equal(fake.closes, 0);
    assert.deepEqual(await tmp.entries(), []);
  } finally { await tmp.restore(); }
});

test("Codex review classifies failures as replay-safe runtime failures", async () => {
  const refused = new FakeServer();
  refused.rejectThreadStart = true;
  const preStart = await rejection(reviewingCodex(refused.client()).review!("p"));
  assert.equal(preStart.kind, "pre_start");
  assert.equal(preStart.replaySafe, true);

  for (const [code, kind] of [["unauthorized", "authentication"], ["usageLimitExceeded", "usage"], [undefined, "uncertain"]] as const) {
    const fake = new FakeServer();
    const pending = rejection(reviewingCodex(fake.client()).review!("p"));
    await fake.started();
    fake.emit("turn/completed", { threadId: "review-thread", turn: { id: "review-turn", status: "failed", error: { codexErrorInfo: code } } });
    const error = await pending;
    assert.equal(error.kind, kind);
    assert.equal(error.replaySafe, true);
    assert.equal(fake.sent.some((entry) => entry.method === "turn/interrupt"), false);
  }

  // A completed turn with no agent message is not an answer.
  const empty = new FakeServer();
  const pending = rejection(reviewingCodex(empty.client()).review!("p"));
  await empty.started();
  empty.emit("turn/completed", { threadId: "review-thread", turn: { id: "review-turn", status: "completed" } });
  assert.equal((await pending).kind, "uncertain");
});

test("OpenCode reports reviews unsupported without spawning anything", () => {
  const runtime: AgentRuntime = new OpenCodeRuntime({ executable: join(tmpdir(), "inoai-missing-opencode-cli") });
  assert.equal(runtime.review, undefined);
  assert.equal("review" in runtime, true);
});
