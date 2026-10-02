import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeFailure } from "../agent-runtime.js";
import type { RuntimeEvent } from "../agent-runtime.js";
import { resumeAgentSession, startAgentSession } from "../agent-session.js";
import { openCodePermissionDenialNotifier } from "../approval-relay.js";
import { ConversationWorker } from "../conversation-worker.js";
import { archiveMessage, createSession, getSession, listMessages, openDatabase, upsertUser } from "../database.js";
import { OpenCodeRuntime } from "../opencode-runtime.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import { runRuntimeTurn } from "../runtime-turn.js";

type Scenario = { lines?: unknown[]; exit?: number; hang?: boolean; onSigint?: unknown[]; stderr?: string };
type Check = "exists" | "missing" | "error" | "hang";
type Call = { kind: "version" | "check" | "run"; argv: string[]; cwd: string; stdin: string; pid: number; sentinel: string | null; envKeys: string[] };

// A fake `opencode` that records every call, answers the existence check from check.json, and replays one recorded
// NDJSON scenario per `run` call. "$SID" becomes the --session value, or a fresh OpenCode-style ID on a first run.
const fakeScript = `
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
appendFileSync(join(dir, "pids"), process.pid + "\\n");
const callsFile = join(dir, "calls.jsonl");
const read = () => { try { return readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const record = (kind, stdin) => appendFileSync(callsFile, JSON.stringify({ kind, argv, cwd: process.cwd(), stdin, pid: process.pid,
  sentinel: process.env.INOAI_OPENCODE_SENTINEL ?? null, envKeys: Object.keys(process.env).sort() }) + "\\n");
if (argv[0] === "--version") { record("version", ""); process.exit(0); }
if (argv[0] === "api") {
  record("check", "");
  const checks = JSON.parse(readFileSync(join(dir, "check.json"), "utf8"));
  const index = read().filter((call) => call.kind === "check").length - 1;
  const check = checks[Math.min(index, checks.length - 1)];
  const id = argv[3].split("/").at(-1);
  if (check === "hang") { process.on("SIGINT", () => process.exit(130)); setInterval(() => {}, 1000); }
  else if (check === "exists") { process.stdout.write(JSON.stringify({ data: { id, outcome: "succeeded" } }) + "\\n"); process.exit(0); }
  else if (check === "missing") { process.stdout.write(JSON.stringify({ _tag: "SessionNotFoundError", sessionID: id, message: "Session not found: " + id }) + "\\n"); process.exit(1); }
  else { process.stdout.write("Error: database is locked\\n"); process.exit(1); }
} else {
  const runs = read().filter((call) => call.kind === "run").length;
  const scenarios = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  const scenario = scenarios[Math.min(runs, scenarios.length - 1)];
  const flag = argv.indexOf("--session");
  const sid = flag >= 0 ? argv[flag + 1] : "ses_fake" + String(runs).padStart(22, "0");
  let stdin = "";
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", () => {
    record("run", stdin);
    const emit = (events) => { for (const event of events) process.stdout.write((typeof event === "string" ? event : JSON.stringify(event).replaceAll("$SID", sid)) + "\\n"); };
    if (scenario.stderr) process.stderr.write(scenario.stderr);
    emit(scenario.lines ?? []);
    if (scenario.onSigint) process.on("SIGINT", () => { emit(scenario.onSigint); process.exit(130); });
    if (scenario.hang || scenario.onSigint) setInterval(() => {}, 1000);
    else process.exitCode = scenario.exit ?? 0;
  });
}
`;

async function fakeCli(scenarios: Scenario[], checks: Check[] = ["exists"]) {
  const dir = await mkdtemp(join(tmpdir(), "inoai-fake-opencode-"));
  const executable = join(dir, "fake-opencode.mjs");
  await writeFile(executable, `#!${process.execPath}\n${fakeScript}`);
  await chmod(executable, 0o755);
  const setScenarios = (next: Scenario[]) => writeFile(join(dir, "scenario.json"), JSON.stringify(next));
  const setChecks = (next: Check[]) => writeFile(join(dir, "check.json"), JSON.stringify(next));
  await setScenarios(scenarios);
  await setChecks(checks);
  const calls = async (): Promise<Call[]> => (await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
  const reset = () => rm(join(dir, "calls.jsonl"), { force: true });
  // Recorded at process start, so a process killed before it read stdin is still visible.
  const pids = async (): Promise<number[]> => (await readFile(join(dir, "pids"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  return { dir, executable, setScenarios, setChecks, calls, reset, pids, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function collect(turn: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
}

async function failure(turn: AsyncIterable<RuntimeEvent>): Promise<RuntimeFailure> {
  try {
    await collect(turn);
  } catch (error) {
    assert.ok(error instanceof RuntimeFailure, `expected RuntimeFailure, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the Turn to fail");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

const secret = "sk-SECRET-opencode-tool-input";
const stepStart = { type: "step_start", sessionID: "$SID", part: { type: "step-start" } };
const text = (value: string) => ({ type: "text", sessionID: "$SID", part: { type: "text", text: value } });
const toolStepFinish = { type: "step_finish", sessionID: "$SID", part: { type: "step-finish", reason: "tool-calls" } };
const rejectedTool = { type: "tool_use", sessionID: "$SID", part: { type: "tool", tool: "read", state: { status: "error", input: { path: secret },
  error: "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.",
  metadata: { providerCall: { executed: false }, rawInput: secret } } } };
const errorEvent = (type: string) => ({ type: "error", sessionID: "$SID", error: { type, message: secret } });
const answered = (value: string): Scenario => ({ lines: [stepStart, text(value)] });
const known = "ses_known0000000000000000000000";
const persona = (instructions: string, prompt: string) => `[inoai operating instructions (not a user message)]\n${instructions}\n[end of inoai operating instructions]\n\n${prompt}`;
const baseArgv = ["run", "--format", "json", "--standalone"];
const forbidden = /^--(model|auto|yolo|dangerously|fork|continue|agent|prompt|thinking)|^-m$|^-c$/i;

test("answers from the final step only, reports the new session once, and resumes it with the persona on every Turn", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-opencode-project-"));
  const fake = await fakeCli([
    { lines: [stepStart, text("Let me check that file."), rejectedTool, toolStepFinish, { type: "future_event", sessionID: "$SID" }, "not json",
      stepStart, text("First part."), text("Second part.")] },
    answered("Again"),
  ]);
  const previous = process.env.INOAI_OPENCODE_SENTINEL;
  process.env.INOAI_OPENCODE_SENTINEL = "inherited";
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(project, "Planner personality\n");
    assert.match(id, /^inoai-new:[0-9a-f-]{36}$/);
    const events = await collect(runtime.runTurn(id, "--question that looks like a flag"));
    const sid = "ses_fake0000000000000000000000";
    assert.deepEqual(events, [{ type: "session", id: sid }, { type: "answer", text: "First part.\n\nSecond part." }]);
    assert.equal(JSON.stringify(events).includes(secret), false);

    await runtime.resumeSession(sid, project, "Edited personality");
    assert.deepEqual(await collect(runtime.runTurn(sid, "follow-up")), [{ type: "answer", text: "Again" }]);

    const calls = await fake.calls();
    assert.deepEqual(calls.map((call) => call.kind), ["run", "run"]);
    const [first, second] = calls;
    assert.deepEqual(first.argv, baseArgv);
    assert.deepEqual(second.argv, [...baseArgv, "--session", sid]);
    assert.equal(first.stdin, persona("Planner personality", "--question that looks like a flag"));
    assert.equal(second.stdin, persona("Edited personality", "follow-up"));
    for (const call of calls) {
      assert.equal(call.cwd, await realpath(project));
      assert.equal(call.sentinel, "inherited");
      assert.deepEqual(call.envKeys, Object.keys(process.env).sort());
      for (const arg of call.argv) assert.doesNotMatch(arg, forbidden);
    }
  } finally {
    if (previous === undefined) delete process.env.INOAI_OPENCODE_SENTINEL;
    else process.env.INOAI_OPENCODE_SENTINEL = previous;
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("binds the placeholder, rebinds it to the streamed OpenCode ID with the OpenCode actor, and stores no tool data", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  const fake = await fakeCli([{ lines: [stepStart, rejectedTool, toolStepFinish, stepStart, text("Bound")] }, answered("Resumed")]);
  try {
    const home = await bootstrapRuntimeHome(project);
    await writeFile(home.agentFile, "Planner personality");
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "opencode", agent_session_id: "pending:message", project_path: project });
      const runtime = new OpenCodeRuntime({ executable: fake.executable });
      const placeholder = await startAgentSession(database, runtime, session.id, home);
      assert.equal(getSession(database, session.id)!.agent_session_id, placeholder);
      assert.equal(getSession(database, session.id)!.updated_by, "runtime:opencode");
      const outcome = await runRuntimeTurn(database, runtime, session.id, placeholder, "question");
      assert.deepEqual(outcome, { state: "completed", answer: "Bound", attempts: 1, replaySafe: false });
      const bound = getSession(database, session.id)!;
      assert.equal(bound.agent_session_id, "ses_fake0000000000000000000000");
      assert.equal(bound.updated_by, "runtime:opencode");
      const resumed = await resumeAgentSession(database, runtime, session.id, home);
      assert.equal(resumed, bound.agent_session_id);
      assert.equal((await runRuntimeTurn(database, runtime, session.id, resumed, "next")).state, "completed");
      assert.deepEqual((await fake.calls()).map((call) => call.argv.slice(4)), [[], ["--session", resumed]]);
      const stored = JSON.stringify(["sessions", "messages", "events"].map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
      assert.equal(stored.includes(secret), false);
      assert.equal(/permission|tool/i.test(stored), false);
    } finally { database.close(); }
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("checks a resumed session once per process before its first --session run", async () => {
  const fake = await fakeCli([answered("One"), answered("Two")], ["exists"]);
  try {
    const restarted = new OpenCodeRuntime({ executable: fake.executable });
    await restarted.resumeSession(known, fake.dir, "personality");
    assert.deepEqual(await collect(restarted.runTurn(known, "question")), [{ type: "answer", text: "One" }]);
    await restarted.resumeSession(known, fake.dir, "personality");
    assert.deepEqual(await collect(restarted.runTurn(known, "question")), [{ type: "answer", text: "Two" }]);
    const calls = await fake.calls();
    assert.deepEqual(calls.map((call) => call.kind), ["check", "run", "run"]);
    assert.deepEqual(calls[0].argv, ["api", "--standalone", "GET", `/api/session/${known}`]);
    assert.deepEqual(calls[1].argv, [...baseArgv, "--session", known]);
  } finally { await fake.cleanup(); }
});

test("a session ID stored from a failed first Turn is checked before its first resume", async () => {
  const fake = await fakeCli([
    { exit: 1, lines: [{ type: "error", sessionID: "$SID", error: { type: "provider.auth", status: 403, message: "OpenCode's free tier can only be used from within OpenCode" } }] },
    answered("Recovered"), answered("Later"),
  ], ["exists"]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const turn = runtime.runTurn(id, "question")[Symbol.asyncIterator]();
    const sid = "ses_fake0000000000000000000000";
    assert.deepEqual(await turn.next(), { value: { type: "session", id: sid }, done: false });
    await assert.rejects(turn.next(), (error: unknown) => error instanceof RuntimeFailure && error.kind === "authentication" && !error.replaySafe);
    await runtime.resumeSession(sid, fake.dir, "personality");
    assert.deepEqual(await collect(runtime.runTurn(sid, "question")), [{ type: "answer", text: "Recovered" }]);
    assert.deepEqual(await collect(runtime.runTurn(sid, "question")), [{ type: "answer", text: "Later" }]);
    const calls = await fake.calls();
    assert.deepEqual(calls.map((call) => call.kind), ["run", "check", "run", "run"]);
    assert.deepEqual(calls.slice(2).map((call) => call.argv.slice(4)), [["--session", sid], ["--session", sid]]);
  } finally { await fake.cleanup(); }
});

test("a vanished session fails closed as session_missing without running, and a failed check is a replay-safe pre-start", async () => {
  const fake = await fakeCli([answered("never")], ["missing"]);
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const restarted = new OpenCodeRuntime({ executable: fake.executable });
    await restarted.resumeSession(known, fake.dir, "personality");
    const error = await failure(restarted.runTurn(known, "question"));
    assert.equal(error.kind, "session_missing");
    assert.equal(error.replaySafe, false);
    assert.deepEqual((await fake.calls()).map((call) => call.kind), ["check"]);

    const home = await bootstrapRuntimeHome(project);
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "opencode", agent_session_id: known, project_path: project });
      await fake.reset();
      assert.deepEqual(await runRuntimeTurn(database, restarted, session.id, known, "question"), { state: "failed", reason: "session_missing", attempts: 1, replaySafe: false,
        notice: "This thread's OpenCode session could not be found. Use /inoai reset to start a new session." });
      assert.deepEqual((await fake.calls()).map((call) => call.kind), ["check"]);

      // A check that fails without SessionNotFoundError ran no Turn, so it is retried and never runs --session.
      await fake.setChecks(["error"]);
      await fake.reset();
      const outcome = await runRuntimeTurn(database, restarted, session.id, known, "question");
      assert.deepEqual([outcome.state, outcome.attempts, outcome.replaySafe], ["failed", 3, true]);
      assert.equal(outcome.state === "failed" && outcome.reason, "pre_start");
      assert.deepEqual((await fake.calls()).map((call) => call.kind), ["check", "check", "check"]);
    } finally { database.close(); }

    // A placeholder from an earlier process never learned its OpenCode ID, so nothing can be resumed.
    await fake.reset();
    const orphan = "inoai-new:00000000-0000-4000-8000-000000000000";
    await restarted.resumeSession(orphan, fake.dir, "personality");
    const orphaned = await failure(restarted.runTurn(orphan, "question"));
    assert.deepEqual([orphaned.kind, orphaned.replaySafe], ["session_missing", false]);
    assert.deepEqual(await fake.calls(), []);

    const missingCli = new OpenCodeRuntime({ executable: join(tmpdir(), "inoai-missing-opencode", "opencode") });
    await missingCli.resumeSession(known, fake.dir, "personality");
    const unspawnable = await failure(missingCli.runTurn(known, "question"));
    assert.deepEqual([unspawnable.kind, unspawnable.replaySafe], ["pre_start", true]);
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("maps exit codes and error events to failure kinds with the documented precedence", async () => {
  const cases: Array<{ name: string; scenario: Scenario; kind: RuntimeFailure["kind"]; resume?: boolean }> = [
    { name: "free-tier refusal", kind: "authentication", scenario: { exit: 1, lines: [{ type: "error", sessionID: "$SID", error: { type: "provider.auth", status: 403, response: { body: "FreeTierError" } } }] } },
    { name: "auth error after text", kind: "authentication", scenario: { exit: 1, lines: [stepStart, text("partial"), errorEvent("provider.auth")] } },
    { name: "rate limit", kind: "usage", scenario: { exit: 1, lines: [stepStart, errorEvent("provider.rate-limit")] } },
    { name: "quota", kind: "usage", scenario: { exit: 1, lines: [errorEvent("provider.quota")] } },
    { name: "other error event", kind: "uncertain", scenario: { exit: 1, lines: [stepStart, errorEvent("provider.transport")] } },
    { name: "error event with exit 0 and text", kind: "uncertain", scenario: { exit: 0, lines: [stepStart, text("x"), errorEvent("unknown")] } },
    { name: "exit 0 without error or text", kind: "uncertain", scenario: { exit: 0, lines: [stepStart] } },
    { name: "exit 0 with only interim tool-step text", kind: "uncertain", scenario: { exit: 0, lines: [stepStart, text("narration"), toolStepFinish, stepStart] } },
    { name: "exit 0 with blank final text", kind: "uncertain", scenario: { exit: 0, lines: [stepStart, text("  ")] } },
    { name: "non-zero exit with no events", kind: "uncertain", scenario: { exit: 1, lines: [] } },
    { name: "exit 130 without cancel", kind: "uncertain", scenario: { exit: 130, lines: [stepStart, errorEvent("unknown")] } },
    { name: "process lost after text", kind: "uncertain", scenario: { exit: 1, lines: [stepStart, text("partial")] } },
    { name: "events for another session", kind: "uncertain", resume: true, scenario: { lines: [{ ...stepStart, sessionID: "ses_other" }, { ...text("wrong"), sessionID: "ses_other" }] } },
  ];
  const fake = await fakeCli([]);
  try {
    for (const { name, scenario, kind, resume } of cases) {
      await fake.setScenarios([scenario]);
      await fake.reset();
      const runtime = new OpenCodeRuntime({ executable: fake.executable });
      let id = known;
      if (resume) await runtime.resumeSession(id, fake.dir, "personality");
      else id = await runtime.createSession(fake.dir, "personality");
      const error = await failure(runtime.runTurn(id, "question"));
      assert.equal(error.kind, kind, name);
      assert.equal(error.replaySafe, false, name);
    }
  } finally { await fake.cleanup(); }
});

test("connect checks the CLI version; a never-spawned first Turn is a replay-safe pre-start and stays new", async () => {
  const fake = await fakeCli([answered("Started")]);
  try {
    assert.ok(await OpenCodeRuntime.connect({ executable: fake.executable }) instanceof OpenCodeRuntime);
    assert.deepEqual((await fake.calls()).map((call) => call.argv), [["--version"]]);
    const later = join(fake.dir, "later-opencode.mjs");
    await assert.rejects(OpenCodeRuntime.connect({ executable: later }), /OpenCode CLI is unavailable/);
    const runtime = new OpenCodeRuntime({ executable: later });
    const id = await runtime.createSession(fake.dir, "personality");
    const error = await failure(runtime.runTurn(id, "question"));
    assert.deepEqual([error.kind, error.replaySafe], ["pre_start", true]);
    await writeFile(later, await readFile(fake.executable));
    await chmod(later, 0o755);
    await fake.reset();
    await runtime.resumeSession(id, fake.dir, "personality");
    assert.deepEqual(await collect(runtime.runTurn(id, "question")), [{ type: "session", id: "ses_fake0000000000000000000000" }, { type: "answer", text: "Started" }]);
    assert.deepEqual((await fake.calls()).map((call) => call.argv), [baseArgv]);
  } finally { await fake.cleanup(); }
});

test("an idle Turn times out, kills the CLI, and is not replay-safe", async () => {
  const fake = await fakeCli([{ hang: true, lines: [stepStart] }]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable, idleTimeoutMs: 500 });
    const id = await runtime.createSession(fake.dir, "personality");
    const error = await failure(runtime.runTurn(id, "question"));
    assert.deepEqual([error.kind, error.replaySafe], ["timed_out", false]);
    const pids = await fake.pids();
    assert.equal(pids.length, 1);
    assert.equal(alive(pids[0]), false);
  } finally { await fake.cleanup(); }
});

test("cancel sends SIGINT, waits for exit, and leaves the session resumable without a new check", async () => {
  const fake = await fakeCli([
    answered("First"),
    { lines: [stepStart], onSigint: [errorEvent("unknown")] },
    answered("After cancel"),
  ]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    await collect(runtime.runTurn(id, "question"));
    const sid = "ses_fake0000000000000000000000";
    await runtime.resumeSession(sid, fake.dir, "personality");
    const pending = failure(runtime.runTurn(sid, "long essay"));
    await waitFor(async () => (await fake.calls()).length === 2);
    await assert.rejects(runtime.runTurn(sid, "overlap").next(), /active turn/);
    await runtime.cancel(sid);
    const error = await pending;
    assert.deepEqual([error.kind, error.replaySafe], ["cancelled", false]);
    assert.equal(alive((await fake.calls())[1].pid), false);
    assert.deepEqual(await collect(runtime.runTurn(sid, "next")), [{ type: "answer", text: "After cancel" }]);
    assert.deepEqual((await fake.calls()).map((call) => [call.kind, ...call.argv.slice(4)]), [["run"], ["run", "--session", sid], ["run", "--session", sid]]);
  } finally { await fake.cleanup(); }
});

test("a cancel before any event or during the existence check is cancelled, not a replay-safe pre-start", async () => {
  const fake = await fakeCli([{ lines: [], onSigint: [] }], ["hang"]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const pending = failure(runtime.runTurn(id, "question"));
    await waitFor(async () => (await fake.calls()).length === 1);
    await runtime.cancel(id);
    const error = await pending;
    assert.deepEqual([error.kind, error.replaySafe], ["cancelled", false]);
    assert.equal(alive((await fake.calls())[0].pid), false);

    await fake.reset();
    await runtime.resumeSession(known, fake.dir, "personality");
    const checking = failure(runtime.runTurn(known, "question"));
    await waitFor(async () => (await fake.calls()).length === 1);
    await runtime.cancel(known);
    const cancelled = await checking;
    assert.deepEqual([cancelled.kind, cancelled.replaySafe], ["cancelled", false]);
    const calls = await fake.calls();
    assert.deepEqual(calls.map((call) => call.kind), ["check"]);
    assert.equal(alive(calls[0].pid), false);
  } finally { await fake.cleanup(); }
});

test("close stops active CLI processes and refuses new Turns", async () => {
  const fake = await fakeCli([{ hang: true, lines: [stepStart] }]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const pending = failure(runtime.runTurn(id, "question"));
    await waitFor(async () => (await fake.calls()).length === 1);
    await assert.rejects(runtime.resumeSession(id, fake.dir, "personality"), /active turn/);
    await runtime.close();
    assert.equal(alive((await fake.calls())[0].pid), false);
    assert.equal((await pending).kind, "uncertain");
    assert.equal(runtime.health().state, "stopped");
    const refused = await failure(runtime.runTurn(id, "question"));
    assert.deepEqual([refused.kind, refused.replaySafe], ["pre_start", true]);
  } finally { await fake.cleanup(); }
});

async function eventsUntilFailure(turn: AsyncIterable<RuntimeEvent>): Promise<{ events: RuntimeEvent[]; error: RuntimeFailure }> {
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of turn) events.push(event);
  } catch (error) {
    assert.ok(error instanceof RuntimeFailure, `expected RuntimeFailure, got ${String(error)}`);
    return { events, error };
  }
  assert.fail("expected the Turn to fail");
}

test("a Turn whose events carry no session ID never answers and never silently succeeds in a new session", async () => {
  const unbound: Scenario = { lines: [{ type: "step_start", part: { type: "step-start" } }, { type: "text", part: { type: "text", text: "lost" } }] };
  const fake = await fakeCli([unbound, unbound]);
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    for (let turn = 0; turn < 2; turn++) {
      const { events, error } = await eventsUntilFailure(runtime.runTurn(id, "question"));
      assert.deepEqual(events, []);
      assert.deepEqual([error.kind, error.replaySafe], ["uncertain", false]);
    }
    const calls = await fake.calls();
    assert.deepEqual(calls.map((call) => call.argv), [baseArgv, baseArgv]);
    for (const call of calls) assert.equal(alive(call.pid), false);
  } finally { await fake.cleanup(); }
});

test("a malformed streamed session ID fails closed and never reaches argv, the API path, or the alias map", async () => {
  const fake = await fakeCli([]);
  try {
    for (const bad of ["--x", "../x", ""]) {
      const malformed: Scenario = { lines: [{ ...stepStart, sessionID: bad }, { ...text("x"), sessionID: bad }] };
      await fake.setScenarios([malformed, answered("Fresh"), malformed, answered("Kept")]);
      await fake.reset();
      const runtime = new OpenCodeRuntime({ executable: fake.executable });

      // A new session is not rebound, so the next in-process Turn starts fresh rather than resuming the malformed ID.
      const id = await runtime.createSession(fake.dir, "personality");
      const first = await eventsUntilFailure(runtime.runTurn(id, "question"));
      assert.deepEqual(first.events, [], bad);
      assert.deepEqual([first.error.kind, first.error.replaySafe], ["uncertain", false], bad);
      assert.deepEqual(await collect(runtime.runTurn(id, "again")), [{ type: "session", id: "ses_fake0000000000000000000001" }, { type: "answer", text: "Fresh" }], bad);

      // A resumed session keeps its existing OpenCode ID.
      await runtime.resumeSession(known, fake.dir, "personality");
      const resumed = await eventsUntilFailure(runtime.runTurn(known, "question"));
      assert.deepEqual([resumed.events, resumed.error.kind], [[], "uncertain"], bad);
      assert.deepEqual(await collect(runtime.runTurn(known, "again")), [{ type: "answer", text: "Kept" }], bad);

      // The malformed ID was never aliased, so resuming it is an unknown key that is refused without a CLI call.
      const before = (await fake.calls()).length;
      await runtime.resumeSession(bad, fake.dir, "personality");
      assert.equal((await failure(runtime.runTurn(bad, "question"))).kind, "session_missing", bad);

      const calls = await fake.calls();
      assert.equal(calls.length, before, bad);
      assert.deepEqual(calls.map((call) => [call.kind, ...call.argv.slice(4)]),
        [["run"], ["run"], ["check"], ["run", "--session", known], ["run", "--session", known]], bad);
      for (const call of calls) {
        assert.equal(call.argv.includes(bad), false, bad);
        assert.equal(call.argv.includes(`/api/session/${bad}`), false, bad);
        assert.equal(alive(call.pid), false, bad);
      }
    }
  } finally { await fake.cleanup(); }
});

test("a malformed session ID resumed from SQLite is session_missing without any CLI call", async () => {
  const fake = await fakeCli([answered("never")], ["exists"]);
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const runtime = new OpenCodeRuntime({ executable: fake.executable });
    for (const bad of ["--x", "../x", ""]) {
      await runtime.resumeSession(bad, fake.dir, "personality");
      const error = await failure(runtime.runTurn(bad, "question"));
      assert.deepEqual([error.kind, error.replaySafe], ["session_missing", false], bad);
    }

    const home = await bootstrapRuntimeHome(project);
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "opencode", agent_session_id: "../x", project_path: project });
      const resumed = await resumeAgentSession(database, runtime, session.id, home);
      assert.equal(resumed, "../x");
      const outcome = await runRuntimeTurn(database, runtime, session.id, resumed, "question");
      assert.deepEqual([outcome.state, outcome.state === "failed" && outcome.reason, outcome.replaySafe], ["failed", "session_missing", false]);
      assert.equal(getSession(database, session.id)!.agent_session_id, "../x");
    } finally { database.close(); }
    assert.deepEqual(await fake.calls(), []);
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("OpenCode permission rejections fail closed with one non-secret notice and Event per Turn, after a first-Turn rebind", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-opencode-denial-"));
  const tokens = ["sk-test-AAAAAAAAAAAAAAAAAAAA", "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"];
  const raw = tokens.join(" ");
  const rejection = "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.";
  const rejected = (tool: string, input: unknown) => ({ type: "tool_use", sessionID: "$SID", part: { type: "tool", tool, state: { status: "error", input,
    error: `${rejection} ${raw}`, metadata: { providerCall: { executed: false }, rawInput: raw } } } });
  // An ordinary tool failure, even one mentioning permissions, is not an auto-rejection.
  const failedCommand = { type: "tool_use", sessionID: "$SID", part: { type: "tool", tool: "bash", state: { status: "error", input: { command: `false ${raw}` },
    error: `Command failed: permission denied ${raw}` } } };
  const completedTool = { type: "tool_use", sessionID: "$SID", part: { type: "tool", tool: "read", state: { status: "completed", input: { path: raw }, output: rejection } } };
  const stderr = `! permission requested: read (secret.env ${raw}); auto-rejecting\n! permission requested: external_directory (/${tokens[1]}/*); auto-rejecting\n`;
  const fake = await fakeCli([
    // Turn 1 (first Turn, placeholder then rebind): two rejections in one Turn, one failed command; the Turn still answers.
    { stderr, lines: [stepStart, rejected("read", { path: `secret.env ${raw}` }), rejected("bash", { command: `ls /usr/share ${raw}` }), failedCommand, completedTool,
      toolStepFinish, stepStart, text("Both actions were blocked; nothing changed.")] },
    // Turn 2 (resumed): one rejection on a failed Turn; the failure stands.
    { stderr, exit: 1, lines: [stepStart, rejected("read", { path: raw }), { type: "error", sessionID: "$SID", error: { type: "unknown", message: raw } }] },
    // Turn 3: only an ordinary tool failure, no notice.
    { lines: [stepStart, failedCommand, toolStepFinish, stepStart, text("Plain answer")] },
  ]);
  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as Array<keyof typeof originals>) console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  const home = await bootstrapRuntimeHome(project);
  const database = openDatabase(home);
  try {
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "first", agent_provider: "opencode", agent_session_id: "pending:first", project_path: project });
    const sends: unknown[][] = [];
    const transport = {
      async sendMessage(...args: unknown[]) { sends.push(args); return `discord-${sends.length}`; },
      async showWorking() {},
    };
    const reported: Array<[string, number]> = [];
    const notify = openCodePermissionDenialNotifier(database, transport as never);
    const runtime = new OpenCodeRuntime({ executable: fake.executable, onPermissionDenied: (id, count) => { reported.push([id, count]); notify(id, count); } });
    const worker = new ConversationWorker(database, home, runtime, "opencode", () => {}, transport);
    for (const id of ["first", "second", "third"]) {
      archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null });
    }
    worker.wake();
    for (let i = 0; i < 500 && sends.length < 5; i++) { await worker.idle(); await new Promise((resolve) => setTimeout(resolve, 5)); }
    await worker.idle();

    // The listener receives the streamed OpenCode ID, which SQLite already holds after the first-Turn rebind.
    const bound = "ses_fake0000000000000000000000";
    assert.equal(getSession(database, session.id)!.agent_session_id, bound);
    assert.deepEqual(reported, [[bound, 2], [bound, 1]]);
    const notice = "OpenCode permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local OpenCode for the blocked action.";
    const bodies = sends.map((args) => args[1]);
    assert.equal(bodies.filter((body) => body === notice).length, 2);
    assert.ok(bodies.includes("Both actions were blocked; nothing changed."));
    assert.ok(bodies.includes("Plain answer"));
    // Plain text sends only: no reply reference, components, or other actionable controls.
    assert.ok(sends.every((args) => args.length === 2 && args[0] === "thread" && typeof args[1] === "string"));

    const events = database.prepare("SELECT session_id, message_id, detail, created_by FROM events WHERE event_type = 'approval_unsupported' ORDER BY id").all();
    assert.deepEqual(events.map((row) => ({ ...row })), [
      { session_id: session.id, message_id: null, detail: "declined: no safe action preview; denials=2", created_by: "runtime:opencode" },
      { session_id: session.id, message_id: null, detail: "declined: no safe action preview; denials=1", created_by: "runtime:opencode" },
    ]);
    const archived = listMessages(database, session.id).filter((row) => row.direction === "agent" && row.body === notice);
    assert.equal(archived.length, 2);
    assert.ok(archived.every((row) => row.state === "completed" && row.external_message_id?.startsWith("discord-") && row.created_by === "transport:discord"));
    const turns = listMessages(database, session.id).filter((row) => row.direction === "user").map((row) => row.state);
    assert.deepEqual(turns, ["completed", "failed", "completed"]);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count, 0);

    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const dump = JSON.stringify(tables.map(({ name }) => database.prepare(`SELECT * FROM "${name}"`).all()));
    for (const token of tokens) {
      assert.equal(dump.includes(token), false, `SQLite contains ${token.slice(0, 4)}`);
      assert.equal(JSON.stringify(sends).includes(token), false);
      assert.equal(logged.join("\n").includes(token), false);
    }
    assert.equal(/secret\.env|external_directory|cannot ask the user|Command failed|usr\/share/i.test(JSON.stringify([dump, sends, logged])), false);
    for (const call of await fake.calls()) assert.equal(call.argv.some((arg) => forbidden.test(arg)), false);
    await worker.stop();
  } finally {
    Object.assign(console, originals);
    database.close();
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("a throwing denial listener never changes the Turn outcome, and no rejection means no call", async () => {
  const fake = await fakeCli([{ lines: [stepStart, rejectedTool, toolStepFinish, stepStart, text("ok")] }, answered("clean")]);
  try {
    const reported: Array<[string, number]> = [];
    const runtime = new OpenCodeRuntime({ executable: fake.executable, onPermissionDenied: (id, count) => { reported.push([id, count]); throw new Error("listener failed"); } });
    const id = await runtime.createSession(fake.dir, "personality");
    assert.deepEqual(await collect(runtime.runTurn(id, "question")), [{ type: "session", id: "ses_fake0000000000000000000000" }, { type: "answer", text: "ok" }]);
    assert.deepEqual(await collect(runtime.runTurn(id, "next")), [{ type: "answer", text: "clean" }]);
    assert.deepEqual(reported, [["ses_fake0000000000000000000000", 1]]);
  } finally { await fake.cleanup(); }
});
