import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "../test/sqlite-store.js";

import { resumeAgentSession, startAgentSession } from "../conversation/agent-session.js";
import type { CodexAppServer } from "../codex-app-server.js";
import { CodexRuntime } from "../codex-runtime.js";
import { RuntimeFailure } from "../agent-runtime.js";
import { createSession, getSession, openDatabase, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

class FakeServer {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  closes = 0;
  interruptCompletes = true;
  interruptFails = false;
  rejectDuplicateInterrupt = false;
  private notices = new Set<(method: string, params: unknown) => void>();
  private failures = new Set<(error: Error) => void>();
  health(): { state: "ready" } { return { state: "ready" }; }
  async close(): Promise<void> { this.closes++; }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "thread/start") return { thread: { id: "real-thread" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${this.sent.filter((entry) => entry.method === "turn/start").length}` } };
    if (method === "turn/interrupt") {
      if (this.rejectDuplicateInterrupt && this.sent.filter((entry) => entry.method === "turn/interrupt").length > 1) throw new Error("Duplicate interruption rejected");
      if (this.interruptFails) throw new Error("Codex interruption failed");
      if (this.interruptCompletes) this.emit("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } });
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  }
  addNotificationListener(listener: (method: string, params: unknown) => void): () => void { this.notices.add(listener); return () => this.notices.delete(listener); }
  addFailureListener(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  emit(method: string, params: unknown): void { for (const listener of this.notices) listener(method, params); }
  fail(): void { for (const listener of this.failures) listener(new Error("Codex app-server exited")); }
  client(): CodexAppServer { return this as unknown as CodexAppServer; }
}

test("starts a persistent thread, stores its ID, and resumes with project instructions", async () => {
  const project = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(project);
    await writeFile(home.agentFile, "Planner personality");
    const database = openDatabase(home);
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "codex", agent_session_id: "pending:message", project_path: project });
      const fake = new FakeServer();
      const runtime = new CodexRuntime(fake.client());
      assert.equal(await startAgentSession(sqliteStore(database), runtime, session.id, home), "real-thread");
      assert.equal(getSession(database, session.id)?.agent_session_id, "real-thread");
      assert.deepEqual(fake.sent[0], { method: "thread/start", params: { cwd: project, developerInstructions: "Planner personality" } });
      assert.equal(await resumeAgentSession(sqliteStore(database), runtime, session.id, home), "real-thread");
      assert.deepEqual(fake.sent[1], { method: "thread/resume", params: { threadId: "real-thread", cwd: project, developerInstructions: "Planner personality" } });
      await assert.rejects(startAgentSession(sqliteStore(database), runtime, session.id, home), /not pending/);
    } finally { database.close(); }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("streams progress and emits the final answer once", async () => {
  const fake = new FakeServer();
  const runtime = new CodexRuntime(fake.client());
  await runtime.createSession("/project", "personality");
  const iterator = runtime.runTurn("real-thread", "question")[Symbol.asyncIterator]();
  const progress = iterator.next();
  fake.emit("item/agentMessage/delta", { threadId: "other", turnId: "turn-1", delta: "wrong" });
  fake.emit("item/agentMessage/delta", { threadId: "real-thread", turnId: "turn-1", delta: "Hello" });
  assert.deepEqual(await progress, { value: { type: "progress", text: "Hello" }, done: false });
  const answer = iterator.next();
  fake.emit("item/completed", { threadId: "real-thread", turnId: "turn-1", item: { type: "agentMessage", text: "Hello world" } });
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-1", status: "completed" } });
  assert.deepEqual(await answer, { value: { type: "answer", text: "Hello world" }, done: false });
  assert.equal((await iterator.next()).done, true);
  assert.deepEqual(fake.sent.at(-1), { method: "turn/start", params: { threadId: "real-thread", input: [{ type: "text", text: "question" }], cwd: "/project" } });
});

test("cancellation leaves the session usable and process loss never fabricates an answer", async () => {
  const fake = new FakeServer();
  const runtime = new CodexRuntime(fake.client());
  await runtime.createSession("/project", "personality");
  const interrupted = runtime.runTurn("real-thread", "first")[Symbol.asyncIterator]();
  const first = interrupted.next();
  await runtime.cancel("real-thread");
  await assert.rejects(first, /cancelled/);

  const resumed = runtime.runTurn("real-thread", "second")[Symbol.asyncIterator]();
  const second = resumed.next();
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-2", status: "completed" } });
  assert.deepEqual(await second, { value: { type: "answer", text: "" }, done: false });
  assert.equal((await resumed.next()).done, true);

  const lost = runtime.runTurn("real-thread", "third")[Symbol.asyncIterator]();
  const third = lost.next();
  fake.fail();
  await assert.rejects(third, /exited/);
});

test("closing a progress stream keeps the Session locked until Codex confirms interruption", async () => {
  const fake = new FakeServer();
  fake.interruptCompletes = false;
  const runtime = new CodexRuntime(fake.client());
  await runtime.createSession("/project", "personality");
  const first = runtime.runTurn("real-thread", "first")[Symbol.asyncIterator]();
  const progress = first.next();
  fake.emit("item/agentMessage/delta", { threadId: "real-thread", turnId: "turn-1", delta: "working" });
  assert.equal((await progress).value?.type, "progress");

  const stopping = first.return(undefined);
  await assert.rejects(runtime.runTurn("real-thread", "overlap")[Symbol.asyncIterator]().next(), /active turn/);
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-1", status: "interrupted" } });
  assert.equal((await stopping).done, true);

  const second = runtime.runTurn("real-thread", "second")[Symbol.asyncIterator]();
  const answer = second.next();
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-2", status: "completed" } });
  assert.equal((await answer).value?.type, "answer");
  await second.next();
  assert.equal(fake.sent.filter(({ method }) => method === "turn/interrupt").length, 1);
});

test("failed interruption after early stream closure leaves the Session locked", async () => {
  const fake = new FakeServer();
  fake.interruptFails = true;
  const runtime = new CodexRuntime(fake.client());
  await runtime.createSession("/project", "personality");
  const first = runtime.runTurn("real-thread", "first")[Symbol.asyncIterator]();
  const progress = first.next();
  fake.emit("item/agentMessage/delta", { threadId: "real-thread", turnId: "turn-1", delta: "working" });
  await progress;
  await assert.rejects(first.return(undefined), /interruption failed/);
  await assert.rejects(runtime.runTurn("real-thread", "overlap")[Symbol.asyncIterator]().next(), /active turn/);
});

test("silent post-start stream times out without releasing its active Session", async () => {
  const fake = new FakeServer();
  const runtime = new CodexRuntime(fake.client(), 20);
  await runtime.createSession("/project", "personality");
  const first = runtime.runTurn("real-thread", "first")[Symbol.asyncIterator]();
  await assert.rejects(first.next(), (error: unknown) => error instanceof RuntimeFailure && error.kind === "timed_out" && !error.replaySafe);
  assert.equal(fake.closes, 1);
  await assert.rejects(runtime.runTurn("real-thread", "overlap")[Symbol.asyncIterator]().next(), /active turn/);
  assert.equal(fake.sent.filter(({ method }) => method === "turn/start").length, 1);
});

test("cancel then early stream closure shares one interrupt and releases after terminal notice", async () => {
  const fake = new FakeServer();
  fake.interruptCompletes = false;
  fake.rejectDuplicateInterrupt = true;
  const runtime = new CodexRuntime(fake.client());
  await runtime.createSession("/project", "personality");
  const first = runtime.runTurn("real-thread", "first")[Symbol.asyncIterator]();
  const progress = first.next();
  fake.emit("item/agentMessage/delta", { threadId: "real-thread", turnId: "turn-1", delta: "working" });
  await progress;

  await runtime.cancel("real-thread");
  const stopping = first.return(undefined);
  await assert.rejects(runtime.runTurn("real-thread", "overlap")[Symbol.asyncIterator]().next(), /active turn/);
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-1", status: "interrupted" } });
  assert.equal((await stopping).done, true);
  assert.equal(fake.sent.filter(({ method }) => method === "turn/interrupt").length, 1);

  const second = runtime.runTurn("real-thread", "second")[Symbol.asyncIterator]();
  const answer = second.next();
  fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-2", status: "completed" } });
  assert.equal((await answer).value?.type, "answer");
  await second.next();
});

test("structured Codex auth and usage failures are classified without exposing raw details", async () => {
  for (const [code, expected] of [["unauthorized", "authentication"], ["usageLimitExceeded", "usage"], ["rateLimitExceeded", "usage"]] as const) {
    const fake = new FakeServer();
    const runtime = new CodexRuntime(fake.client());
    await runtime.createSession("/project", "personality");
    const turn = runtime.runTurn("real-thread", "question")[Symbol.asyncIterator]();
    const result = turn.next();
    fake.emit("turn/completed", { threadId: "real-thread", turn: { id: "turn-1", status: "failed", error: { codexErrorInfo: code, message: "token=secret-123" } } });
    await assert.rejects(result, (error: unknown) => error instanceof Error && error.message === expected);
  }
});
