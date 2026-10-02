import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeFailure } from "../agent-runtime.js";
import type { RuntimeEvent } from "../agent-runtime.js";
import { resumeAgentSession, startAgentSession } from "../agent-session.js";
import { claudePermissionDenialNotifier } from "../approval-relay.js";
import { ClaudeRuntime } from "../claude-runtime.js";
import { ConversationWorker } from "../conversation-worker.js";
import { archiveMessage, createSession, getSession, listMessages, openDatabase, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import { runRuntimeTurn } from "../runtime-turn.js";

type Scenario = { lines?: unknown[]; exit?: number; hang?: boolean; onSigint?: unknown[] };
type Call = { argv: string[]; cwd: string; stdin: string; pid: number };

// A fake `claude` that records its argv, cwd, and stdin, then replays recorded stream-json lines.
const fakeScript = `
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const calls = join(dir, "calls.jsonl");
let index = 0;
try { index = readFileSync(calls, "utf8").split("\\n").filter(Boolean).length; } catch {}
const scenarios = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const scenario = scenarios[Math.min(index, scenarios.length - 1)];
const flag = argv.findIndex((arg) => arg === "--session-id" || arg === "--resume");
const sid = argv[flag + 1];
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  appendFileSync(calls, JSON.stringify({ argv, cwd: process.cwd(), stdin, pid: process.pid }) + "\\n");
  const emit = (events) => { for (const event of events) process.stdout.write(JSON.stringify(event).replaceAll("$SID", sid) + "\\n"); };
  emit(scenario.lines ?? []);
  if (scenario.onSigint) process.on("SIGINT", () => { emit(scenario.onSigint); process.exit(0); });
  if (scenario.hang || scenario.onSigint) setInterval(() => {}, 1000);
  else process.exitCode = scenario.exit ?? 0;
});
`;

async function fakeCli(scenarios: Scenario[]) {
  const dir = await mkdtemp(join(tmpdir(), "inoai-fake-claude-"));
  const executable = join(dir, "fake-claude.mjs");
  await writeFile(executable, `#!${process.execPath}\n${fakeScript}`);
  await chmod(executable, 0o755);
  const setScenarios = (next: Scenario[]) => writeFile(join(dir, "scenario.json"), JSON.stringify(next));
  await setScenarios(scenarios);
  const calls = async (): Promise<Call[]> => (await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
  return { dir, executable, setScenarios, calls, cleanup: () => rm(dir, { recursive: true, force: true }) };
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

const init = { type: "system", subtype: "init", session_id: "$SID", apiKeySource: "none" };
const delta = (text: string, parent: string | null = null) => ({ type: "stream_event", session_id: "$SID", parent_tool_use_id: parent, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const success = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: "$SID", permission_denials: [] });
const notFound = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["No conversation found with session ID: $SID"] };
const aborted = { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", stop_reason: null, errors: ["[ede_diagnostic] result_type=user"] };
const secret = "sk-ant-SECRET-tool-input";

test("streams text deltas as progress, yields one answer, and resumes the same session ID", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-claude-project-"));
  const fake = await fakeCli([{ lines: [
    init,
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    delta("Hel"),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: secret } }] }, parent_tool_use_id: null },
    delta("subagent text", "toolu_1"),
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_1", message: secret },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: secret }] } },
    { type: "system", subtype: "undocumented_future_event" },
    "not json",
    delta("lo"),
    { ...success("Hello"), permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: secret } }] },
  ] }, { lines: [init, success("Again")] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(project, "Planner personality");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const events = await collect(runtime.runTurn(id, "--question that looks like a flag"));
    assert.deepEqual(events, [{ type: "progress", text: "Hel" }, { type: "progress", text: "lo" }, { type: "answer", text: "Hello" }]);
    assert.equal(JSON.stringify(events).includes(secret), false);

    await runtime.resumeSession(id, project, "Edited personality");
    assert.deepEqual(await collect(runtime.runTurn(id, "follow-up")), [{ type: "answer", text: "Again" }]);

    const [first, second] = await fake.calls();
    assert.deepEqual(first.argv, ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--session-id", id, "--append-system-prompt=Planner personality", "--system-prompt-snapshot", "off", "--permission-prompts", "none"]);
    assert.equal(first.stdin, "--question that looks like a flag");
    assert.equal(first.cwd, await realpath(project));
    assert.deepEqual(second.argv, ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--resume", id, "--append-system-prompt=Edited personality", "--system-prompt-snapshot", "off", "--permission-prompts", "none"]);
    for (const arg of [...first.argv, ...second.argv]) {
      assert.doesNotMatch(arg, /^--(dangerously|allowed-?tools|allow|settings|permission-mode|model|mcp|add-dir|no-session-persistence|bare)/i);
    }
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("passes the model as one --model= argv element only when configured", async () => {
  const fake = await fakeCli([{ lines: [init, success("ok")] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, model: "claude-sonnet-5-5[1m]" });
    const id = await runtime.createSession(fake.dir, "personality");
    await collect(runtime.runTurn(id, "question"));
    const [call] = await fake.calls();
    assert.equal(call.argv.at(-1), "--model=claude-sonnet-5-5[1m]");
    assert.equal(call.argv.includes("--model"), false);
  } finally { await fake.cleanup(); }
});

test("binds the assigned UUID with the Claude runtime actor and uses neutral resume errors", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(project);
    await writeFile(home.agentFile, "Planner personality");
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "claude", agent_session_id: "pending:message", project_path: project });
      const runtime = new ClaudeRuntime({ executable: "/nonexistent/claude" });
      await assert.rejects(resumeAgentSession(database, runtime, session.id, home), /no runtime session to resume/);
      const id = await startAgentSession(database, runtime, session.id, home);
      const bound = getSession(database, session.id)!;
      assert.equal(bound.agent_session_id, id);
      assert.equal(bound.updated_by, "runtime:claude");
      assert.equal(await resumeAgentSession(database, runtime, session.id, home), id);
    } finally { database.close(); }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("maps final result signals to runtime failure kinds, not exit codes", async () => {
  const cases: Array<{ name: string; scenario: Scenario; kind: RuntimeFailure["kind"]; replaySafe: boolean }> = [
    { name: "not logged in", kind: "authentication", replaySafe: false, scenario: { exit: 1, lines: [init,
      { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
      { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Not logged in · Please run /login" }] } },
    { name: "account on hold", kind: "authentication", replaySafe: false, scenario: { lines: [init, { type: "assistant", error: "account_on_hold" }, { type: "result", subtype: "success", is_error: true }] } },
    { name: "rate limit error", kind: "usage", replaySafe: false, scenario: { lines: [init, { type: "assistant", error: "rate_limit" }, { type: "result", subtype: "success", is_error: true }] } },
    { name: "billing error", kind: "usage", replaySafe: false, scenario: { lines: [init, { type: "assistant", error: "billing_error" }, { type: "result", subtype: "success", is_error: true }] } },
    { name: "rejected rate limit event", kind: "usage", replaySafe: false, scenario: { lines: [init, { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, { type: "result", subtype: "error_during_execution", is_error: true }] } },
    { name: "exit without init", kind: "pre_start", replaySafe: true, scenario: { exit: 1, lines: [] } },
    { name: "error result without init", kind: "pre_start", replaySafe: true, scenario: { exit: 1, lines: [{ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["boom"] }] } },
    { name: "error after init", kind: "uncertain", replaySafe: false, scenario: { lines: [init, { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }] } },
    { name: "interrupt without cancel, exit 0", kind: "uncertain", replaySafe: false, scenario: { exit: 0, lines: [init, delta("partial"), aborted] } },
    { name: "process lost after init", kind: "uncertain", replaySafe: false, scenario: { exit: 1, lines: [init, delta("partial")] } },
    { name: "success without answer text", kind: "uncertain", replaySafe: false, scenario: { lines: [init, { type: "result", subtype: "success", is_error: false }] } },
    { name: "error-flagged success result", kind: "uncertain", replaySafe: false, scenario: { exit: 0, lines: [init, { type: "result", subtype: "success", is_error: true, result: "x" }] } },
    { name: "init for another session", kind: "uncertain", replaySafe: false, scenario: { lines: [{ ...init, session_id: "other" }, success("wrong session")] } },
  ];
  const fake = await fakeCli([]);
  try {
    for (const { name, scenario, kind, replaySafe } of cases) {
      await fake.setScenarios([scenario]);
      await rm(join(fake.dir, "calls.jsonl"), { force: true });
      const runtime = new ClaudeRuntime({ executable: fake.executable });
      const id = await runtime.createSession(fake.dir, "personality");
      const error = await failure(runtime.runTurn(id, "question"));
      assert.equal(error.kind, kind, name);
      assert.equal(error.replaySafe, replaySafe, name);
    }
  } finally { await fake.cleanup(); }
});

test("a CLI that cannot be spawned is a replay-safe pre-start failure", async () => {
  const runtime = new ClaudeRuntime({ executable: join(tmpdir(), "inoai-missing-claude", "claude") });
  const id = await runtime.createSession(tmpdir(), "personality");
  const error = await failure(runtime.runTurn(id, "question"));
  assert.equal(error.kind, "pre_start");
  assert.equal(error.replaySafe, true);
  await assert.rejects(ClaudeRuntime.connect({ executable: join(tmpdir(), "inoai-missing-claude", "claude") }), /Claude CLI is unavailable/);
});

// Identity fields are sentinels: no refusal message may ever echo them.
const identity = { email: "owner-sentinel@example.com", orgId: "org-sentinel-id", orgName: "Org Sentinel", subscriptionType: "team" };
const subscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: false, ...identity };

// Runs fn with CLAUDE_CODE_OAUTH_TOKEN set to value, or removed when value is undefined, then restores it exactly.
async function withOauthEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN");
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (value === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = value;
  try { return await fn(); } finally {
    if (had) process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
}

test("connect checks that the CLI starts and accepts only the subscription /login", async () => {
  const fake = await fakeCli([{ exit: 0 }, { exit: 0, lines: [subscription] }]);
  try {
    await withOauthEnv(undefined, async () => {
      assert.equal((await ClaudeRuntime.connect({ executable: fake.executable })).health().state, "ready");
    });
    assert.deepEqual((await fake.calls()).map((call) => call.argv), [["--version"], ["auth", "status", "--json"]]);
  } finally { await fake.cleanup(); }
});

test("connect refuses every non-subscription credential source, naming only its category", async () => {
  const cases: Array<{ name: string; status: unknown; exit?: number; message: RegExp }> = [
    { name: "ANTHROPIC_API_KEY beside a subscription", status: { ...subscription, apiKeySource: "ANTHROPIC_API_KEY" }, message: /refused: an API key \(ANTHROPIC_API_KEY\)/ },
    { name: "API key login", status: { ...subscription, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }, message: /an API key \(ANTHROPIC_API_KEY\)/ },
    { name: "Console managed key", status: { ...subscription, authMethod: "api_key", apiKeySource: "/login managed key" }, message: /a Console API key/ },
    { name: "unknown API-key source", status: { ...subscription, apiKeySource: "org" }, message: /refused: an API key would/ },
    { name: "apiKeyHelper source", status: { ...subscription, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" }, message: /an apiKeyHelper/ },
    { name: "apiKeyHelper auth method", status: { ...subscription, authMethod: "api_key_helper" }, message: /an apiKeyHelper/ },
    // A token supplied through the owner's settings env block: no CLAUDE_CODE_OAUTH_TOKEN in this process's environment.
    { name: "auth token or Anthropic profile", status: { ...subscription, authMethod: "oauth_token" }, message: /an auth token or Anthropic profile/ },
    { name: "Bedrock", status: { ...subscription, authMethod: "third_party", apiProvider: "bedrock" }, message: /a cloud provider/ },
    { name: "Vertex beside a subscription", status: { ...subscription, apiProvider: "vertex" }, message: /a cloud provider/ },
    { name: "cloud gateway", status: { ...subscription, apiProvider: "gateway" }, message: /a cloud gateway/ },
    { name: "unknown auth method", status: { ...subscription, authMethod: "future" }, message: /an unsupported credential source/ },
    { name: "not logged in", exit: 1, status: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, message: /sign-in is required; run claude \/login locally/ },
    { name: "logged out flag", status: { ...subscription, loggedIn: false }, message: /sign-in is required; run claude \/login/ },
    { name: "subscription fields with a failing exit", exit: 1, status: subscription, message: /could not be verified; run claude \/login/ },
    { name: "missing fields", status: { loggedIn: true }, message: /could not be verified/ },
    { name: "not JSON", status: "Logged in as owner-sentinel@example.com", message: /could not be verified/ },
    { name: "no output", exit: 1, status: undefined, message: /could not be verified/ },
  ];
  const fake = await fakeCli([]);
  try {
    await withOauthEnv(undefined, async () => {
      for (const { name, status, exit, message } of cases) {
        await fake.setScenarios([{ exit: 0 }, { exit: exit ?? 0, lines: status === undefined ? [] : [status] }]);
        await rm(join(fake.dir, "calls.jsonl"), { force: true });
        const error = await ClaudeRuntime.connect({ executable: fake.executable }).then(() => assert.fail(`${name}: expected refusal`), (failure: unknown) => failure);
        assert.ok(error instanceof Error, name);
        assert.match(error.message, message, name);
        for (const value of Object.values(identity)) assert.equal(error.message.includes(value), false, `${name} leaked ${value}`);
      }
    });
  } finally { await fake.cleanup(); }
});

test("connect refuses when CLAUDE_CODE_OAUTH_TOKEN is present, checking presence only", async () => {
  const fake = await fakeCli([{ exit: 0 }, { exit: 0, lines: [subscription] }]);
  try {
    for (const value of ["sk-ant-oat01-SENTINEL-token", ""]) {
      await rm(join(fake.dir, "calls.jsonl"), { force: true });
      await withOauthEnv(value, async () => {
        const error = await ClaudeRuntime.connect({ executable: fake.executable }).then(() => assert.fail("expected refusal"), (failure: unknown) => failure as Error);
        assert.match(error.message, /refused: CLAUDE_CODE_OAUTH_TOKEN in the environment would override the subscription sign-in/);
        assert.equal(value !== "" && error.message.includes(value), false);
        // The environment is never stripped or changed.
        assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, value);
      });
      assert.deepEqual((await fake.calls()).map((call) => call.argv), [["--version"]]);
    }
  } finally { await fake.cleanup(); }
});

test("a Turn whose init reports an API-key source is killed before it does work", async () => {
  const fake = await fakeCli([]);
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    for (const source of ["ANTHROPIC_API_KEY", "apiKeyHelper", undefined]) {
      // The fake would otherwise hang forever, so only a kill on init settles the Turn before the idle timeout.
      await fake.setScenarios([{ hang: true, lines: [{ ...init, apiKeySource: source }, delta(secret), success(secret)] }]);
      await rm(join(fake.dir, "calls.jsonl"), { force: true });
      let denials = 0;
      const runtime = new ClaudeRuntime({ executable: fake.executable, idleTimeoutMs: 30_000, onPermissionDenied: () => { denials++; } });
      const id = await runtime.createSession(fake.dir, "personality");
      const events: RuntimeEvent[] = [];
      let caught: unknown;
      try { for await (const event of runtime.runTurn(id, "question")) events.push(event); } catch (error) { caught = error; }
      assert.ok(caught instanceof RuntimeFailure, String(source));
      assert.equal(caught.kind, "authentication");
      assert.equal(caught.replaySafe, false);
      assert.deepEqual(events, []);
      assert.equal(denials, 0);
      const [call] = await fake.calls();
      assert.equal(alive(call.pid), false);
    }

    // Through the shared Turn loop it is attempted once and the notice carries the Claude login hint.
    await rm(join(fake.dir, "calls.jsonl"), { force: true });
    const runtime = new ClaudeRuntime({ executable: fake.executable, idleTimeoutMs: 30_000 });
    const id = await runtime.createSession(fake.dir, "personality");
    const home = await bootstrapRuntimeHome(project);
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "claude", agent_session_id: id, project_path: project });
      const outcome = await runRuntimeTurn(database, runtime, session.id, id, "question");
      assert.deepEqual(outcome, { state: "failed", reason: "authentication", attempts: 1, replaySafe: false,
        notice: "Claude sign-in needs attention. Run claude /login locally, then send a fresh request." });
      assert.equal((await fake.calls()).length, 1);
    } finally { database.close(); }
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("an idle Turn times out, kills the CLI, and is not replay-safe", async () => {
  const fake = await fakeCli([{ hang: true, lines: [init, delta("thinking")] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable, idleTimeoutMs: 200 });
    const id = await runtime.createSession(fake.dir, "personality");
    const error = await failure(runtime.runTurn(id, "question"));
    assert.equal(error.kind, "timed_out");
    assert.equal(error.replaySafe, false);
    assert.equal(alive((await fake.calls())[0].pid), false);
  } finally { await fake.cleanup(); }
});

test("cancel sends SIGINT, waits for settlement, and leaves the session resumable", async () => {
  const fake = await fakeCli([
    { lines: [init, delta("partial")], onSigint: [{ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }, aborted] },
    { lines: [init, success("After cancel")] },
  ]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const iterator = runtime.runTurn(id, "long essay")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: { type: "progress", text: "partial" }, done: false });
    await assert.rejects(runtime.runTurn(id, "overlap").next(), /active turn/);
    await runtime.cancel(id);
    const [call] = await fake.calls();
    assert.equal(alive(call.pid), false);
    await assert.rejects(iterator.next(), (error: unknown) => error instanceof RuntimeFailure && error.kind === "cancelled" && !error.replaySafe);

    assert.deepEqual(await collect(runtime.runTurn(id, "next")), [{ type: "answer", text: "After cancel" }]);
    assert.equal((await fake.calls())[1].argv.includes("--resume"), true);
  } finally { await fake.cleanup(); }
});

test("a first Turn that never persisted is retried as new within the process", async () => {
  const fake = await fakeCli([{ exit: 1, lines: [] }, { lines: [init, success("First")] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    assert.equal((await failure(runtime.runTurn(id, "question"))).kind, "pre_start");
    await runtime.resumeSession(id, fake.dir, "personality");
    assert.deepEqual(await collect(runtime.runTurn(id, "question")), [{ type: "answer", text: "First" }]);
    assert.deepEqual((await fake.calls()).map((call) => call.argv[5]), ["--session-id", "--session-id"]);
  } finally { await fake.cleanup(); }
});

test("a resume that finds no conversation fails closed as session_missing and is never recreated or replayed", async () => {
  const fake = await fakeCli([{ exit: 1, lines: [notFound] }]);
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    // After a restart the session is resumed from SQLite; a missing transcript must not start a new conversation.
    const restarted = new ClaudeRuntime({ executable: fake.executable });
    const lost = "00000000-0000-4000-8000-000000000000";
    await restarted.resumeSession(lost, fake.dir, "personality");
    const error = await failure(restarted.runTurn(lost, "question"));
    assert.equal(error.kind, "session_missing");
    assert.equal(error.replaySafe, false);
    assert.deepEqual((await fake.calls()).map((call) => [call.argv[5], call.argv[6]]), [["--resume", lost]]);

    // Through the shared Turn loop it is attempted once and the notice points the owner at /inoai reset.
    await rm(join(fake.dir, "calls.jsonl"));
    const home = await bootstrapRuntimeHome(project);
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "claude", agent_session_id: lost, project_path: project });
      const outcome = await runRuntimeTurn(database, restarted, session.id, lost, "question");
      assert.deepEqual(outcome, { state: "failed", reason: "session_missing", attempts: 1, replaySafe: false,
        notice: "This thread's Claude session could not be found. Use /inoai reset to start a new session." });
      assert.equal((await fake.calls()).length, 1);
    } finally { database.close(); }
  } finally {
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("a session whose init was seen but whose transcript is later missing yields session_missing", async () => {
  const fake = await fakeCli([
    { exit: 1, lines: [init, { type: "assistant", error: "authentication_failed" }, { type: "result", subtype: "success", is_error: true }] },
    { exit: 1, lines: [notFound] },
  ]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    assert.equal((await failure(runtime.runTurn(id, "question"))).kind, "authentication");
    const error = await failure(runtime.runTurn(id, "question"));
    assert.equal(error.kind, "session_missing");
    assert.equal(error.replaySafe, false);
    assert.deepEqual((await fake.calls()).map((call) => call.argv[5]), ["--session-id", "--resume"]);
  } finally { await fake.cleanup(); }
});

test("a cancel before init is cancelled, not a replay-safe pre-start failure", async () => {
  const fake = await fakeCli([{ lines: [], onSigint: [] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const pending = failure(runtime.runTurn(id, "question"));
    for (let i = 0; i < 200 && (await fake.calls()).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.cancel(id);
    const error = await pending;
    assert.equal(error.kind, "cancelled");
    assert.equal(error.replaySafe, false);
    assert.equal(alive((await fake.calls())[0].pid), false);
  } finally { await fake.cleanup(); }
});

test("close stops active CLI processes and refuses new Turns", async () => {
  const fake = await fakeCli([{ hang: true, lines: [init, delta("working")] }]);
  try {
    const runtime = new ClaudeRuntime({ executable: fake.executable });
    const id = await runtime.createSession(fake.dir, "personality");
    const iterator = runtime.runTurn(id, "question")[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: { type: "progress", text: "working" }, done: false });
    await assert.rejects(runtime.resumeSession(id, fake.dir, "personality"), /active turn/);
    await runtime.close();
    assert.equal(alive((await fake.calls())[0].pid), false);
    await assert.rejects(iterator.next(), (error: unknown) => error instanceof RuntimeFailure && error.kind === "uncertain");
    assert.equal(runtime.health().state, "stopped");
    const refused = await failure(runtime.runTurn(id, "question"));
    assert.equal(refused.kind, "pre_start");
    assert.equal(refused.replaySafe, true);
  } finally { await fake.cleanup(); }
});

test("Claude permission denials fail closed with one non-secret notice and Event per Turn", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-claude-denial-"));
  const tokens = ["sk-test-AAAAAAAAAAAAAAAAAAAA", "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"];
  const raw = tokens.join(" ");
  const toolUse = (id: string, name: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name, input: { command: `echo ${raw}`, file_path: `/tmp/${tokens[0]}`, content: raw } }] } });
  const denied = (id: string, name: string) => ({ type: "system", subtype: "permission_denied", tool_name: name, tool_use_id: id, message: `echo ${raw} in '/tmp/${tokens[1]}' needs approval` });
  const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: `denied: ${raw}` }] } });
  const denial = (id: string, name: string) => ({ tool_name: name, tool_use_id: id, tool_input: { command: `echo ${raw}`, file_path: `/tmp/${tokens[0]}` } });
  const fake = await fakeCli([
    // Turn 1: two denials reported by both events and the result; the Turn still succeeds.
    { lines: [init, toolUse("toolu_1", "Bash"), denied("toolu_1", "Bash"), toolResult("toolu_1"),
      toolUse("toolu_2", "Write"), denied("toolu_2", "Write"), toolResult("toolu_2"), delta("Blocked"),
      { ...success("Both actions were blocked; nothing changed."), permission_denials: [denial("toolu_1", "Bash"), denial("toolu_2", "Write")] }] },
    // Turn 2: a denial reported only in the result of a failed Turn; the failure stands.
    { lines: [init, { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], permission_denials: [denial("toolu_3", "Bash")] }] },
    // Turn 3: no denial, no notice.
    { lines: [init, success("Plain answer")] },
  ]);
  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as Array<keyof typeof originals>) console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  const home = await bootstrapRuntimeHome(project);
  const database = openDatabase(home);
  try {
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "first", agent_provider: "claude", agent_session_id: "pending:first", project_path: project });
    const sends: unknown[][] = [];
    const transport = {
      async sendMessage(...args: unknown[]) { sends.push(args); return `discord-${sends.length}`; },
      async showWorking() {},
    };
    const runtime = new ClaudeRuntime({ executable: fake.executable, onPermissionDenied: claudePermissionDenialNotifier(database, transport as never) });
    const worker = new ConversationWorker(database, home, runtime, "claude", () => {}, transport);
    for (const id of ["first", "second", "third"]) {
      archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null });
    }
    worker.wake();
    for (let i = 0; i < 500 && sends.length < 5; i++) { await worker.idle(); await new Promise((resolve) => setTimeout(resolve, 5)); }
    await worker.idle();

    const notice = "Claude permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local Claude for the blocked action.";
    const bodies = sends.map((args) => args[1]);
    assert.equal(bodies.filter((body) => body === notice).length, 2);
    assert.ok(bodies.includes("Both actions were blocked; nothing changed."));
    assert.ok(bodies.includes("Plain answer"));
    // Plain text sends only: no reply reference, components, or other actionable controls.
    assert.ok(sends.every((args) => args.length === 2 && args[0] === "thread" && typeof args[1] === "string"));

    const events = database.prepare("SELECT session_id, message_id, detail, created_by FROM events WHERE event_type = 'approval_unsupported' ORDER BY id").all();
    assert.deepEqual(events.map((row) => ({ ...row })), [
      { session_id: session.id, message_id: null, detail: "declined: no safe action preview; denials=2", created_by: "runtime:claude" },
      { session_id: session.id, message_id: null, detail: "declined: no safe action preview; denials=1", created_by: "runtime:claude" },
    ]);
    const archived = listMessages(database, session.id).filter((row) => row.direction === "agent" && row.body === notice);
    assert.equal(archived.length, 2);
    assert.ok(archived.every((row) => row.state === "completed" && row.external_message_id?.startsWith("discord-")));
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
    for (const call of await fake.calls()) {
      assert.doesNotMatch(call.argv.join(" "), /--(allowed-?tools|permission-mode|dangerously|settings)/i);
    }
    await worker.stop();
  } finally {
    Object.assign(console, originals);
    database.close();
    await fake.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("a throwing denial listener never changes the Turn outcome", async () => {
  const fake = await fakeCli([{ lines: [init, { type: "system", subtype: "permission_denied", tool_name: "Bash", message: secret }, success("ok")] }]);
  try {
    const reported: Array<[string, number]> = [];
    const runtime = new ClaudeRuntime({ executable: fake.executable, onPermissionDenied: (id, count) => { reported.push([id, count]); throw new Error("listener failed"); } });
    const id = await runtime.createSession(fake.dir, "personality");
    assert.deepEqual(await collect(runtime.runTurn(id, "question")), [{ type: "answer", text: "ok" }]);
    assert.deepEqual(reported, [[id, 1]]);
  } finally { await fake.cleanup(); }
});
