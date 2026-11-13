import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { sqliteStore } from "../../../test/sqlite-store.js";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../agent-instance/runtime-home.js";
import { archiveMessage, createSession, listMessages, openDatabase, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import type { OperationalStore } from "../../persistence/operational-store.js";
import { loadRole, renderRoleBlock } from "../../roles/role-file.js";
import { loadAgentProfileWithSkills } from "../../skills/skill-loader.js";

const providers = ["codex", "claude", "opencode", "anthropic-api"] as const;
type Provider = typeof providers[number];
type Call = { kind: "create" | "resume" | "turn"; id: string; text: string };

type Fixture = { directory: string; home: RuntimeHome; database: DatabaseSync; ownerId: number; release: () => Promise<void> };

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-role-composition-"));
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
    display_name: null, role: "owner", state: "active" })!;
  return { directory, home, database, ownerId: owner.id,
    release: async () => { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

function fakeRuntime(calls: Call[], options: { gate?: Promise<void>; failResume?: () => boolean } = {}): AgentRuntime {
  return {
    displayName: "Fake", loginHint: "none",
    async createSession(_path, instructions) { calls.push({ kind: "create", id: "", text: instructions }); return `runtime-${Math.random()}`; },
    async resumeSession(id, _path, instructions) {
      if (options.failResume?.()) throw new Error("resume failed");
      calls.push({ kind: "resume", id, text: instructions });
    },
    async *runTurn(id, prompt): AsyncGenerator<RuntimeEvent> {
      calls.push({ kind: "turn", id, text: prompt });
      if (options.gate) await options.gate;
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

function addMessage(f: Fixture, sessionId: number, id: string): void {
  archiveMessage(f.database, { session_id: sessionId, transport: "discord", workspace_id: "guild", external_message_id: id,
    external_author_id: "owner", user_id: f.ownerId, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null });
}

async function runChat(f: Fixture, store: OperationalStore, provider: Provider, runtime: AgentRuntime): Promise<void> {
  const worker = new ConversationWorker(store, f.home, runtime, provider);
  try { worker.wake(); await worker.idle(); } finally { await worker.stop(); }
}

async function runTask(f: Fixture, provider: Provider, runtime: AgentRuntime, sent: string[] = []): Promise<{ taskId: number; sessionId: number }> {
  const store = createSqliteOperationalStore(f.database);
  const session = addSession(f, provider, `task-${provider}-${Date.now()}-${Math.random()}`, `pending:task:${Math.random()}`);
  const task = await store.createTask({ goal: "Make a report", task_type: "recurring", interval_seconds: 3600,
    conversation_id: session.conversation_id, session_id: session.id });
  const transport = { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; } };
  const runner = new TaskRunExecutor(store, runtime, f.home, transport, { reserveTaskRun: async () => () => {} }, provider);
  assert.equal(await runner.start(task.id), "started");
  const deadline = Date.now() + 5_000;
  while ((await store.listTaskRuns(task.id))[0]?.state === "processing") {
    if (Date.now() > deadline) throw new Error("Task Run did not finish");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await runner.stop();
  return { taskId: task.id, sessionId: session.id };
}

function roleEvents(database: DatabaseSync, sessionId: number): string[] {
  return (database.prepare("SELECT detail FROM events WHERE session_id=? AND event_type='role_applied' ORDER BY id").all(sessionId) as Array<{ detail: string }>).map((row) => row.detail);
}

test("with no role, chat and Task Run instructions for every provider equal the base profile output", async () => {
  for (const provider of providers) {
    const f = await fixture();
    try {
      const base = await loadAgentProfileWithSkills(f.home);
      // A store without the role methods (as PostgreSQL) and the SQLite store with no role equipped.
      for (const [label, store] of [["no role methods", sqliteStore(f.database)], ["no role equipped", createSqliteOperationalStore(f.database)]] as const) {
        const calls: Call[] = [];
        const fresh = addSession(f, provider, `${label}-new`, `pending:${label}`);
        const resumed = addSession(f, provider, `${label}-old`, `${provider}-${label}`);
        addMessage(f, fresh.id, `${label}-m1`);
        addMessage(f, resumed.id, `${label}-m2`);
        await runChat(f, store, provider, fakeRuntime(calls));
        const instructions = calls.filter((call) => call.kind !== "turn");
        assert.deepEqual(instructions.map((call) => call.kind), ["create", "resume"], `${provider} ${label}`);
        for (const call of instructions) assert.equal(call.text, base, `${provider} ${label}`);
        assert.deepEqual(calls.filter((call) => call.kind === "turn").map((call) => call.text), [`${label}-m1`, `${label}-m2`]);
      }
      const calls: Call[] = [];
      await runTask(f, provider, fakeRuntime(calls));
      assert.equal(calls[0]?.kind, "create");
      assert.equal(calls[0]?.text, base, `${provider} Task Run`);
      assert.doesNotMatch(calls[1]?.text ?? "", /Role changed/);
    } finally { await f.release(); }
  }
});

test("with a role, a chat Turn and a Task Run pass instructions that end with the role block", async () => {
  const f = await fixture();
  try {
    const store = createSqliteOperationalStore(f.database);
    await store.equipRole!("planner", "cli:owner");
    const base = await loadAgentProfileWithSkills(f.home);
    const block = renderRoleBlock(await loadRole(f.home.rolesDirectory, "planner"));
    const expected = `${base.replace(/\n*$/, "\n")}\n${block}`;
    const calls: Call[] = [];
    const session = addSession(f, "codex", "thread", "pending:new");
    addMessage(f, session.id, "m1");
    await runChat(f, store, "codex", fakeRuntime(calls));
    assert.equal(calls[0]?.text, expected);
    assert.ok(calls[0]?.text.endsWith(block));
    assert.match(calls[0]!.text, /\n\n## Equipped Role: Planner\n/);
    assert.equal(calls[1]?.text, "m1"); // A new Session gets no note.
    assert.deepEqual(roleEvents(f.database, session.id), ["role=planner"]);
    const actor = f.database.prepare("SELECT created_by FROM events WHERE event_type='role_applied' AND session_id=?").get(session.id) as { created_by: string };
    assert.equal(actor.created_by, "conversation-worker");

    const taskCalls: Call[] = [];
    const run = await runTask(f, "codex", fakeRuntime(taskCalls));
    assert.equal(taskCalls[0]?.text, expected);
    assert.doesNotMatch(taskCalls[1]?.text ?? "", /Role changed/);
    assert.deepEqual(roleEvents(f.database, run.sessionId), ["role=planner"]);
    const taskActor = f.database.prepare("SELECT created_by FROM events WHERE event_type='role_applied' AND session_id=?").get(run.sessionId) as { created_by: string };
    assert.equal(taskActor.created_by, "task-runtime");
  } finally { await f.release(); }
});

test("a switch adds a one-Turn note to the prompt only, keeps the agent session, and a pre-start failure leaves it pending", async () => {
  const f = await fixture();
  try {
    const store = createSqliteOperationalStore(f.database);
    const planner = renderRoleBlock(await loadRole(f.home.rolesDirectory, "planner"));
    const reviewer = renderRoleBlock(await loadRole(f.home.rolesDirectory, "reviewer"));
    const session = addSession(f, "codex", "thread", "codex-thread");
    const turn = async (id: string, failResume = false): Promise<Call[]> => {
      const calls: Call[] = [];
      addMessage(f, session.id, id);
      await runChat(f, store, "codex", fakeRuntime(calls, { failResume: () => failResume }));
      return calls;
    };

    await store.equipRole!("planner", "cli:owner");
    let calls = await turn("m1");
    assert.equal(calls[1]?.text, "m1");
    assert.ok(calls[0]?.text.endsWith(planner));

    await store.equipRole!("reviewer", "cli:owner");
    calls = await turn("m2");
    assert.deepEqual(calls.map((call) => [call.kind, call.id]), [["resume", "codex-thread"], ["turn", "codex-thread"]]);
    assert.ok(calls[0]?.text.endsWith(reviewer));
    assert.doesNotMatch(calls[0]!.text, /Role changed/);
    assert.equal(calls[1]?.text, "Role changed from planner to reviewer.\n\nm2");

    calls = await turn("m3");
    assert.equal(calls[1]?.text, "m3");
    assert.ok(calls[0]?.text.endsWith(reviewer));

    // A new Session records the role without a note.
    const other = addSession(f, "codex", "thread-2", "codex-thread-2");
    addMessage(f, other.id, "n1");
    const otherCalls: Call[] = [];
    await runChat(f, store, "codex", fakeRuntime(otherCalls));
    assert.equal(otherCalls[1]?.text, "n1");

    // Unequip, then fail the next Turn before the runtime starts: nothing is recorded and the note stays pending.
    await store.unequipRole!("cli:owner");
    calls = await turn("m4", true);
    assert.deepEqual(calls, []);
    assert.equal(listMessages(f.database, session.id).find((row) => row.body === "m4")?.failure_detail, "Agent Session setup failed before runtime start");
    calls = await turn("m5");
    assert.equal(calls[1]?.text, "Role changed from reviewer to none.\n\nm5");
    assert.doesNotMatch(calls[0]!.text, /Equipped Role/);
    calls = await turn("m6");
    assert.equal(calls[1]?.text, "m6");

    assert.deepEqual(roleEvents(f.database, session.id), ["role=planner", "role=reviewer", "role=none"]);
    assert.deepEqual(roleEvents(f.database, other.id), ["role=reviewer"]);
  } finally { await f.release(); }
});

test("a role switch during an in-flight Turn does not change that Turn's instructions", async () => {
  const f = await fixture();
  try {
    const store = createSqliteOperationalStore(f.database);
    const planner = renderRoleBlock(await loadRole(f.home.rolesDirectory, "planner"));
    await store.equipRole!("planner", "cli:owner");
    const session = addSession(f, "codex", "thread", "codex-thread");
    addMessage(f, session.id, "m1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Call[] = [];
    const worker = new ConversationWorker(store, f.home, fakeRuntime(calls, { gate }), "codex");
    try {
      worker.wake();
      const deadline = Date.now() + 5_000;
      while (!calls.some((call) => call.kind === "turn")) {
        if (Date.now() > deadline) throw new Error("Turn did not start");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await store.equipRole!("reviewer", "cli:owner");
      release();
      await worker.idle();
    } finally { await worker.stop(); }
    assert.ok(calls[0]?.text.endsWith(planner));
    assert.equal(listMessages(f.database, session.id).find((row) => row.body === "m1")?.state, "completed");
    assert.deepEqual(roleEvents(f.database, session.id), ["role=planner"]);
    addMessage(f, session.id, "m2");
    const next: Call[] = [];
    await runChat(f, store, "codex", fakeRuntime(next));
    assert.equal(next[1]?.text, "Role changed from planner to reviewer.\n\nm2");
  } finally { await f.release(); }
});

test("a missing or invalid equipped role fails the chat Turn and the Task Run without a runtime call", async () => {
  const f = await fixture();
  try {
    const store = createSqliteOperationalStore(f.database);
    // The store never validates ids, so a role whose file is missing can be equipped here.
    await store.equipRole!("ghost", "cli:owner");
    const session = addSession(f, "codex", "thread", "codex-thread");
    addMessage(f, session.id, "m1");
    const calls: Call[] = [];
    await runChat(f, store, "codex", fakeRuntime(calls));
    assert.deepEqual(calls, []);
    const rows = listMessages(f.database, session.id);
    const user = rows.find((row) => row.direction === "user")!;
    assert.equal(user.state, "failed");
    assert.equal(user.failure_detail, "Equipped role missing or invalid; replay_safe=false");
    assert.equal(user.runtime_started_at, null);
    assert.deepEqual(rows.filter((row) => row.direction === "agent").map((row) => row.body),
      ["Equipped role ghost is missing or invalid; fix roles/ghost.md or unequip it."]);
    assert.deepEqual(f.database.prepare("SELECT detail, created_by FROM events WHERE session_id=? AND event_type='turn_failed'").all(session.id)
      .map((row) => ({ ...row })), [{ detail: "reason=role_invalid", created_by: "conversation-worker" }]);
    assert.deepEqual(roleEvents(f.database, session.id), []);
    assert.equal((await store.getEquippedRole!())?.role_id, "ghost"); // The role stays equipped.

    // An equipped file that becomes invalid fails the Task Run the same way.
    await store.equipRole!("planner", "cli:owner");
    await writeFile(join(f.home.rolesDirectory, "planner.md"), "# Role: Planner\n\nNo sections.\n");
    const taskCalls: Call[] = [];
    const sent: string[] = [];
    const run = await runTask(f, "codex", fakeRuntime(taskCalls), sent);
    assert.deepEqual(taskCalls, []);
    const notice = "Equipped role planner is missing or invalid; fix roles/planner.md or unequip it.";
    const [taskRun] = await store.listTaskRuns(run.taskId);
    assert.equal(taskRun?.state, "failed");
    assert.equal(taskRun?.failure_detail, "Equipped role missing or invalid; replay_safe=false");
    assert.deepEqual(sent, [notice]);
    assert.deepEqual(f.database.prepare("SELECT detail, created_by FROM events WHERE session_id=? AND event_type='turn_failed'").all(run.sessionId)
      .map((row) => ({ ...row })), [{ detail: "reason=role_invalid", created_by: "task-runtime" }]);
    assert.deepEqual(roleEvents(f.database, run.sessionId), []);
    assert.match(await readFile(join(f.home.directory, "results", String(run.taskId), "1", "result.md"), "utf8"), new RegExp(notice.replace(/[.]/g, "\\.")));
    assert.equal((await store.getTask(run.taskId))?.state, "active"); // The schedule stays.
  } finally { await f.release(); }
});
