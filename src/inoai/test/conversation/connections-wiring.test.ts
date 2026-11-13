import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RuntimeFailure } from "../../agent-runtime/ports.js";
import type { AgentRuntime, ConnectionStatus, RuntimeEvent, TurnOptions } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../agent-instance/runtime-home.js";
import { start } from "../../app.js";
import { archiveMessage, createSession, listMessages, openDatabase, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";

const baseEnv = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "MEMORY_REVIEW_TIME=06:00",
  "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"];
const secret = "s3cr3t-value-never-shown";
const validFile = JSON.stringify({ version: 1, connections: {
  github: { type: "stdio", command: "npx", args: ["server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }, allow: ["search_issues"] },
  docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_KEY}" }, allow: "all" },
} });
// References a name that is not in .env.
const invalidFile = JSON.stringify({ version: 1, connections: {
  github: { type: "stdio", command: "npx", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${MISSING_TOKEN}" }, allow: ["search_issues"] },
} });

type Call = { prompt: string; options?: TurnOptions; argCount: number };
type Behavior = { statuses?: { name: string; status: ConnectionStatus }[]; fail?: RuntimeFailure };
type Fixture = { directory: string; home: RuntimeHome; database: DatabaseSync; ownerId: number; release: () => Promise<void> };

async function fixture(provider: string, file?: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-connections-wiring-"));
  const home = await bootstrapRuntimeHome(directory);
  await writeFile(home.envFile, [...baseEnv, `AGENT_PROVIDER=${provider}`, `GITHUB_TOKEN=${secret}`, `DOCS_KEY=${secret}`].join("\n"));
  if (file !== undefined) await writeFile(home.connectionsFile, file, { mode: 0o600 });
  const database = openDatabase(home);
  const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
    display_name: null, role: "owner", state: "active" })!;
  return { directory, home, database, ownerId: owner.id,
    release: async () => { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

function fakeRuntime(calls: Call[], behavior: Behavior = {}): AgentRuntime {
  return {
    displayName: "Fake", loginHint: "none",
    async createSession() { return `runtime-${Math.random()}`; },
    async resumeSession() {},
    async *runTurn(_id, prompt, options?: TurnOptions): AsyncGenerator<RuntimeEvent> {
      calls.push({ prompt, options, argCount: arguments.length });
      if (behavior.fail) throw behavior.fail;
      if (behavior.statuses) yield { type: "connection_status", connections: behavior.statuses };
      yield { type: "answer", text: "done" };
    },
    async cancel() {}, health() { return { state: "ready" }; }, async close() {},
  };
}

function addSession(f: Fixture, provider: string, conversation: string, agentSessionId: string) {
  return createSession(f.database, { user_id: f.ownerId, transport: "discord", workspace_id: "guild",
    parent_conversation_id: "channel", conversation_id: conversation, initiating_external_message_id: `${conversation}-start`,
    agent_provider: provider, agent_session_id: agentSessionId, project_path: f.directory });
}

async function runChat(f: Fixture, provider: string, runtime: AgentRuntime) {
  const session = addSession(f, provider, `chat-${Math.random()}`, "pending:new");
  archiveMessage(f.database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: `m-${Math.random()}`,
    external_author_id: "owner", user_id: f.ownerId, direction: "user", body: "hello", reply_to_external_message_id: null, in_reply_to_message_id: null });
  const worker = new ConversationWorker(createSqliteOperationalStore(f.database), f.home, runtime, provider as "claude");
  try { worker.wake(); await worker.idle(); } finally { await worker.stop(); }
  const rows = listMessages(f.database, session.id);
  return { sessionId: session.id, user: rows.find((row) => row.direction === "user")!, replies: rows.filter((row) => row.direction === "agent").map((row) => row.body) };
}

async function runTask(f: Fixture, provider: string, runtime: AgentRuntime) {
  const store = createSqliteOperationalStore(f.database);
  const session = addSession(f, provider, `task-${Math.random()}`, `pending:task:${Math.random()}`);
  const task = await store.createTask({ goal: "Make a report", task_type: "recurring", interval_seconds: 3600,
    conversation_id: session.conversation_id, session_id: session.id });
  const sent: string[] = [];
  const transport = { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; } };
  const runner = new TaskRunExecutor(store, runtime, f.home, transport, { reserveTaskRun: async () => () => {} }, provider);
  assert.equal(await runner.start(task.id), "started");
  const deadline = Date.now() + 5_000;
  while ((await store.listTaskRuns(task.id))[0]?.state === "processing") {
    if (Date.now() > deadline) throw new Error("Task Run did not finish");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await runner.stop();
  const [run] = await store.listTaskRuns(task.id);
  const result = await readFile(join(f.home.directory, "results", String(task.id), String(run!.id), "result.md"), "utf8");
  return { sessionId: session.id, run: run!, result, sent };
}

function events(f: Fixture, sessionId: number, type: string): Array<{ detail: string; created_by: string }> {
  return (f.database.prepare("SELECT detail, created_by FROM events WHERE session_id=? AND event_type=? ORDER BY id").all(sessionId, type) as Array<{ detail: string; created_by: string }>)
    .map((row) => ({ detail: row.detail, created_by: row.created_by }));
}

function allEventText(f: Fixture): string {
  return JSON.stringify(f.database.prepare("SELECT event_type, detail FROM events").all());
}

async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try { return { value: await fn(), warnings }; } finally { console.warn = original; }
}

test("a Claude home with an invalid connections file refuses to start with a value-free message", async () => {
  const f = await fixture("claude", invalidFile);
  f.database.close();
  try {
    await assert.rejects(start(f.directory), (error: Error) => {
      assert.equal(error.name, "InvalidConnectionsError");
      assert.match(error.message, /connections\.json/);
      assert.match(error.message, /MISSING_TOKEN, which is missing or empty in \.env/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a Claude home with a valid file starts with no warning", async () => {
  const f = await fixture("claude", validFile);
  f.database.close();
  try {
    const { value: instance, warnings } = await captureWarnings(() => start(f.directory));
    await instance.release();
    assert.deepEqual(warnings, []);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a Codex home with an invalid file starts with the warning, runs Turns, and passes no connections", async () => {
  const f = await fixture("codex", invalidFile);
  try {
    const { value: instance, warnings } = await captureWarnings(() => start(f.directory));
    await instance.release();
    assert.deepEqual(warnings, ["Warning: connections.json is ignored; connections are supported only on Claude homes in this version."]);
    const calls: Call[] = [];
    const chat = await runChat(f, "codex", fakeRuntime(calls));
    assert.deepEqual(chat.replies, ["done"]);
    const task = await runTask(f, "codex", fakeRuntime(calls));
    assert.equal(task.run.state, "completed");
    assert.deepEqual(calls.map((call) => call.argCount), [2, 2]);
    assert.doesNotMatch(allEventText(f), /connection/);
  } finally { await f.release(); }
});

test("a Codex home with no file starts with no warning", async () => {
  const f = await fixture("codex");
  f.database.close();
  try {
    const { value: instance, warnings } = await captureWarnings(() => start(f.directory));
    await instance.release();
    assert.deepEqual(warnings, []);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an invalid file edited in after startup fails a chat Turn and a Task Run closed with connections_invalid", async () => {
  const f = await fixture("claude", validFile);
  try {
    await writeFile(f.home.connectionsFile, invalidFile);
    const calls: Call[] = [];
    const notice = "The connections file connections.json is invalid: connection \"github\" env GITHUB_PERSONAL_ACCESS_TOKEN refers to MISSING_TOKEN, which is missing or empty in .env. Fix it, then send a fresh request.";
    const chat = await runChat(f, "claude", fakeRuntime(calls));
    assert.deepEqual(calls, []);
    assert.equal(chat.user.state, "failed");
    assert.equal(chat.user.failure_detail, "Connections file invalid; replay_safe=false");
    assert.equal(chat.user.runtime_started_at, null);
    assert.deepEqual(chat.replies, [notice]);
    assert.deepEqual(events(f, chat.sessionId, "turn_failed"), [{ detail: "reason=connections_invalid", created_by: "conversation-worker" }]);
    assert.deepEqual(events(f, chat.sessionId, "connection_status"), []);

    const task = await runTask(f, "claude", fakeRuntime(calls));
    assert.deepEqual(calls, []);
    assert.equal(task.run.state, "failed");
    assert.equal(task.run.failure_detail, "Connections file invalid; replay_safe=false");
    assert.deepEqual(task.sent, [notice]);
    assert.ok(task.result.includes(notice));
    assert.deepEqual(events(f, task.sessionId, "turn_failed"), [{ detail: "reason=connections_invalid", created_by: "task-runtime" }]);
    assert.doesNotMatch(allEventText(f) + task.result + chat.replies.join(""), new RegExp(secret));
  } finally { await f.release(); }
});

test("connection statuses are recorded per connection with the right actors, and failures add a note", async () => {
  const f = await fixture("claude", validFile);
  try {
    const calls: Call[] = [];
    const statuses = [{ name: "github", status: "failed" as const }, { name: "docs", status: "needs_auth" as const }];
    const chat = await runChat(f, "claude", fakeRuntime(calls, { statuses }));
    assert.deepEqual(Object.keys(calls[0]!.options!.connections!.mcpServers), ["github", "docs"]);
    assert.deepEqual(calls[0]!.options!.connections!.allowedTools, ["mcp__github__search_issues", "mcp__docs"]);
    const note = "Connection github failed to start.\nConnection docs needs authentication; check its credentials in .env.";
    assert.deepEqual(chat.replies, [`done\n\n${note}`]);
    assert.deepEqual(events(f, chat.sessionId, "connection_status"), [
      { detail: "name=github status=failed", created_by: "conversation-worker" },
      { detail: "name=docs status=needs_auth", created_by: "conversation-worker" }]);

    const task = await runTask(f, "claude", fakeRuntime(calls, { statuses }));
    assert.equal(task.run.state, "completed");
    assert.ok(task.result.includes(`## Connections\n\n${note}\n`));
    assert.deepEqual(events(f, task.sessionId, "connection_status"), [
      { detail: "name=github status=failed", created_by: "task-runtime" },
      { detail: "name=docs status=needs_auth", created_by: "task-runtime" }]);
    assert.doesNotMatch(allEventText(f) + task.result + chat.replies.join(""), new RegExp(secret));
  } finally { await f.release(); }
});

test("all connected statuses add no note", async () => {
  const f = await fixture("claude", validFile);
  try {
    const statuses = [{ name: "github", status: "connected" as const }, { name: "docs", status: "connected" as const }];
    const chat = await runChat(f, "claude", fakeRuntime([], { statuses }));
    assert.deepEqual(chat.replies, ["done"]);
    assert.deepEqual(events(f, chat.sessionId, "connection_status").map((row) => row.detail), ["name=github status=connected", "name=docs status=connected"]);
    const task = await runTask(f, "claude", fakeRuntime([], { statuses }));
    assert.doesNotMatch(task.result, /## Connections|Connection /);
  } finally { await f.release(); }
});

test("a Turn that ends before init records every connection as unknown and adds no note", async () => {
  const f = await fixture("claude", validFile);
  try {
    const chat = await runChat(f, "claude", fakeRuntime([], { fail: new RuntimeFailure("pre_start") }));
    assert.equal(chat.user.state, "failed");
    assert.doesNotMatch(chat.replies.join(""), /Connection /);
    assert.deepEqual(events(f, chat.sessionId, "connection_status"), [
      { detail: "name=github status=unknown", created_by: "conversation-worker" },
      { detail: "name=docs status=unknown", created_by: "conversation-worker" }]);

    const task = await runTask(f, "claude", fakeRuntime([], { fail: new RuntimeFailure("timed_out") }));
    assert.equal(task.run.state, "failed");
    assert.doesNotMatch(task.result, /## Connections|Connection /);
    assert.deepEqual(events(f, task.sessionId, "connection_status"), [
      { detail: "name=github status=unknown", created_by: "task-runtime" },
      { detail: "name=docs status=unknown", created_by: "task-runtime" }]);
  } finally { await f.release(); }
});

test("a Claude home with no connections file passes no options and records no connection events", async () => {
  const f = await fixture("claude");
  try {
    const calls: Call[] = [];
    const chat = await runChat(f, "claude", fakeRuntime(calls));
    assert.deepEqual(chat.replies, ["done"]);
    const task = await runTask(f, "claude", fakeRuntime(calls));
    assert.equal(task.run.state, "completed");
    assert.deepEqual(calls.map((call) => call.argCount), [2, 2]);
    assert.doesNotMatch(allEventText(f), /connection/);
    assert.doesNotMatch(task.result, /## Connections/);
  } finally { await f.release(); }
});
