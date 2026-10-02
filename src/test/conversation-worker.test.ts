import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeFailure } from "../agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime.js";
import { ConversationWorker } from "../conversation-worker.js";
import { archiveMessage, claimNextMessage, createSession, listMessages, markRuntimeStarted, openDatabase, upsertUser } from "../database.js";
import { start, startTransport } from "../index.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../transport.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000"].join("\n");

class FakeTransport implements ChatTransport {
  private incoming?: (message: IncomingMessage) => void;
  private onControl?: (control: ThreadControl) => Promise<void>;
  private count = 0;
  start(onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.incoming = onIncoming;
    this.onControl = onControl;
    return Promise.resolve(onReady?.()).then(() => {});
  }
  emit(message: IncomingMessage): void { this.incoming?.(message); }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "thread-a",
      parentConversationId: "channel", externalUserId: "owner",
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> { return `thread-${++this.count}`; }
  async deleteConversation(): Promise<void> {}
  async sendMessage(): Promise<string> { return "sent"; }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: "ready", botUserId: "inoai" }; }
}

function incoming(id: string, conversationId: string, parentConversationId: string | null = null): IncomingMessage {
  return { transport: "discord", workspaceId: "guild", conversationId, parentConversationId,
    externalMessageId: id, externalUserId: "owner", body: id, replyToExternalMessageId: null,
    mentionedUserIds: parentConversationId ? [] : ["inoai"], mentionedBotUserIds: parentConversationId ? [] : ["inoai"],
    botUserId: "inoai", authorIsBot: false };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

test("transport wakes one global FIFO worker; duplicates do not run twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env);
    const instance = await start(directory);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const turns: string[] = [];
    let active = 0;
    let maxActive = 0;
    let created = 0;
    const runtime: AgentRuntime = {
      async createSession() { return `codex-${++created}`; }, async resumeSession() {},
      async *runTurn(_sessionId, prompt): AsyncGenerator<RuntimeEvent> {
        active++; maxActive = Math.max(maxActive, active); turns.push(prompt);
        try { if (prompt === "first") await firstGate; yield { type: "answer", text: `answer:${prompt}` }; }
        finally { active--; }
      },
      async cancel() { releaseFirst(); }, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(instance.database, instance.runtimeHome, runtime);
    try {
      await startTransport(instance, undefined, transport, undefined, worker);
      transport.emit(incoming("first", "channel"));
      transport.emit(incoming("first", "channel"));
      await until(() => turns.length === 1);
      transport.emit(incoming("second", "thread-1", "channel"));
      transport.emit(incoming("second", "thread-1", "channel"));
      transport.emit(incoming("third", "channel"));
      await until(() => instance.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count === 2);
      assert.deepEqual(turns, ["first"]);
      releaseFirst();
      await worker.idle();
      assert.deepEqual(turns, ["first", "second", "third"]);
      assert.equal(maxActive, 1);
      const rows = instance.database.prepare("SELECT direction, state, body, delivery_state FROM messages ORDER BY id").all() as Array<{ direction: string; state: string; body: string; delivery_state: string | null }>;
      assert.deepEqual(rows.filter((row) => row.direction === "user").map((row) => [row.body, row.state]),
        [["first", "completed"], ["second", "completed"], ["third", "completed"]]);
      assert.deepEqual(rows.filter((row) => row.direction === "agent").map((row) => row.delivery_state), ["pending", "pending", "pending"]);
    } finally { await worker.stop(); await transport.stop(); await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("thread controls authorize the owner, isolate cancellation, and reset without replaying old output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-controls-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env);
    const instance = await start(directory);
    const add = (conversation: string, id: string) => {
      const session = createSession(instance.database, { user_id: instance.owner.id, transport: "discord",
        workspace_id: "guild", parent_conversation_id: "channel", conversation_id: conversation,
        initiating_external_message_id: id, agent_provider: "codex", agent_session_id: `codex-${id}`, project_path: directory });
      return session;
    };
    const a = add("thread-a", "a1");
    const b = add("thread-b", "b1");
    for (const [session, id] of [[a, "a1"], [a, "a2"], [b, "b1"]] as const) {
      archiveMessage(instance.database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: id, external_author_id: "owner", user_id: instance.owner.id,
        direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null });
    }
    const gates = new Map<string, () => void>();
    const turns: string[] = [];
    const cancels: string[] = [];
    const runtime: AgentRuntime = {
      async createSession() { return "new-codex-session"; }, async resumeSession() {},
      async *runTurn(_id, prompt) {
        turns.push(prompt);
        await new Promise<void>((resolve) => { gates.set(prompt, resolve); });
        yield { type: "answer" as const, text: `late:${prompt}` };
      },
      async cancel(id) { cancels.push(id); }, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(instance.database, instance.runtimeHome, runtime);
    try {
      worker.enablePerSessionConcurrency();
      await startTransport(instance, undefined, transport, undefined, worker);
      await until(() => gates.has("a1") && gates.has("b1"));
      const before = instance.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'user'").get()?.count;
      assert.match(await transport.control("status"), /Queued: 1; running: 1/);
      assert.match(await transport.control("status", { externalUserId: "intruder" }), /only in your active/);
      assert.match(await transport.control("reset", { parentConversationId: "status" }), /only in your active/);
      assert.match(await transport.control("cancel", { conversationId: "other-bot-thread" }), /only in your active/);
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'user'").get()?.count, before);
      assert.match(await transport.control("cancel"), /Cancellation requested/);
      assert.deepEqual(cancels, ["codex-a1"]);
      gates.get("a1")!();
      await until(() => gates.has("a2"));
      assert.equal(listMessages(instance.database, a.id).find((row) => row.body === "a1")?.state, "failed");
      assert.equal(listMessages(instance.database, b.id).find((row) => row.body === "b1")?.state, "processing");
      transport.emit(incoming("a3", "thread-a", "channel")); // Queued behind the active old turn.
      assert.match(await transport.control("reset"), /Session reset/);
      assert.deepEqual(cancels, ["codex-a1", "codex-a1"]); // Both turns share the old Agent Session.
      assert.deepEqual(listMessages(instance.database, a.id).filter((row) => row.direction === "user").map((row) => row.state), ["failed", "failed", "failed"]);
      assert.equal(turns.includes("a3"), false);
      transport.emit(incoming("a4", "thread-a", "channel"));
      await until(() => turns.includes("a4"));
      const fresh = instance.database.prepare("SELECT id, agent_session_id FROM sessions WHERE conversation_id = 'thread-a' AND state = 'active'").get() as { id: number; agent_session_id: string };
      assert.notEqual(fresh.id, a.id);
      assert.equal(fresh.agent_session_id, "new-codex-session");
      gates.get("a2")!(); // The cancelled old runtime still returns an answer.
      gates.get("a4")!();
      gates.get("b1")!();
      await worker.idle();
      assert.equal(listMessages(instance.database, a.id).filter((row) => row.direction === "agent").length, 0);
      assert.equal(listMessages(instance.database, fresh.id).find((row) => row.body === "a4")?.state, "completed");
      assert.equal(listMessages(instance.database, b.id).find((row) => row.body === "b1")?.state, "completed");
    } finally { for (const release of gates.values()) release(); await worker.stop(); await transport.stop(); await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restart requeues only pre-start work and preserves post-start Session identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-restart-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const add = (id: string, conversation: string) => {
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: conversation, initiating_external_message_id: id,
        agent_provider: "codex", agent_session_id: `codex-${id}`, project_path: directory });
      const message = archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id,
        reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
      return { session, message };
    };
    const before = add("before", "thread-before");
    const after = add("after", "thread-after");
    assert.equal(claimNextMessage(database, "per-session")?.id, before.message.id);
    assert.equal(claimNextMessage(database, "per-session")?.id, after.message.id);
    assert(markRuntimeStarted(database, after.message.id));
    database.close();
    const recovered = openDatabase(home);
    const turns: string[] = [];
    const runtime: AgentRuntime = {
      async createSession() { throw new Error("Should not create a new Agent Session"); },
      async resumeSession(id) { assert.equal(id, "codex-before"); },
      async *runTurn(_id, prompt) { turns.push(prompt); yield { type: "answer" as const, text: "ok" }; },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(recovered, home, runtime);
    try {
      worker.wake();
      await worker.idle();
      assert.deepEqual(turns, ["before"]);
      assert.equal(listMessages(recovered, before.session.id)[0]?.state, "completed");
      assert.equal(listMessages(recovered, after.session.id)[0]?.state, "failed");
      assert.match(listMessages(recovered, after.session.id)[0]?.failure_detail ?? "", /uncertain/);
      assert.equal(recovered.prepare("SELECT agent_session_id FROM sessions WHERE id = ?").get(after.session.id)?.agent_session_id, "codex-after");
    } finally { await worker.stop(); recovered.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("terminal runtime failure is recorded once and does not block the next turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-failure-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "fail",
      agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
    for (const id of ["fail", "ok"]) archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id,
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    const runtime: AgentRuntime = {
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn(_id, prompt) {
        if (prompt === "fail") throw new RuntimeFailure("usage");
        yield { type: "answer" as const, text: "done" };
      },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(database, home, runtime);
    try {
      worker.wake();
      await worker.idle();
      const rows = listMessages(database, session.id);
      assert.deepEqual(rows.filter((row) => row.direction === "user").map((row) => row.state), ["failed", "completed"]);
      assert.match(rows[0]?.failure_detail ?? "", /Runtime usage/);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'turn_failed'").get()?.count, 1);
    } finally { await worker.stop(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shutdown cancels the active turn and leaves later pending input for restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-stop-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "first",
      agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
    for (const id of ["first", "second"]) archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id,
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    const runtime: AgentRuntime = {
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() { entered(); await cancelled; throw new RuntimeFailure("cancelled"); },
      async cancel() { cancel(); }, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(database, home, runtime);
    worker.wake();
    await running;
    await worker.stop();
    assert.deepEqual(listMessages(database, session.id).filter((row) => row.direction === "user").map((row) => row.state), ["failed", "pending"]);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shutdown during a replay-safe backoff never retries after runtime close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-stop-retry-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "first",
      agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
    for (const id of ["first", "second"]) archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user", body: id,
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    let attempts = 0;
    let closed = false;
    let retryAfterClose = false;
    const runtime: AgentRuntime = {
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() {
        attempts++;
        if (closed) retryAfterClose = true;
        throw new RuntimeFailure("pre_start", true);
      },
      async cancel() {}, health() { return { state: "ready" }; }, async close() { closed = true; },
    };
    const worker = new ConversationWorker(database, home, runtime);
    worker.wake();
    await until(() => database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'runtime_failure'").get()?.count === 1);
    await worker.stop();
    assert.equal(attempts, 1);
    assert.equal(retryAfterClose, false);
    assert.equal(closed, true);
    assert.deepEqual(listMessages(database, session.id).filter((row) => row.direction === "user").map((row) => row.state), ["failed", "pending"]);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("validated cross-session overlap keeps Session FIFO and falls back globally after uncertainty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-concurrency-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const addSession = (name: string) => createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: `thread-${name}`, initiating_external_message_id: `${name}1`,
      agent_provider: "codex", agent_session_id: `codex-${name}`, project_path: directory });
    const addMessage = (sessionId: number, id: string) => archiveMessage(database, { session_id: sessionId,
      transport: "discord", workspace_id: "guild", external_message_id: id, external_author_id: "owner",
      user_id: owner.id, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null });
    const a = addSession("A");
    const b = addSession("B");
    addMessage(a.id, "A1"); addMessage(a.id, "A2"); addMessage(b.id, "B1");
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const turns: string[] = [];
    const active = new Map<string, number>();
    let sameSessionOverlap = false;
    const runtime: AgentRuntime = {
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn(sessionId, prompt) {
        turns.push(prompt);
        const count = (active.get(sessionId) ?? 0) + 1;
        active.set(sessionId, count);
        if (count > 1) sameSessionOverlap = true;
        try {
          if (prompt === "A1") { await gateA; throw new RuntimeFailure("uncertain"); }
          if (prompt === "B1") await gateB;
          yield { type: "answer" as const, text: `answer:${prompt}` };
        } finally { active.set(sessionId, (active.get(sessionId) ?? 1) - 1); }
      },
      async cancel() { releaseA(); releaseB(); }, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(database, home, runtime);
    try {
      assert.equal(worker.concurrencyMode(), "global");
      worker.wake();
      await until(() => turns.includes("A1"));
      assert.deepEqual(turns, ["A1"]);
      worker.enablePerSessionConcurrency();
      await until(() => turns.includes("B1"));
      assert.deepEqual(turns, ["A1", "B1"]);
      assert.equal(turns.includes("A2"), false);
      releaseA();
      await until(() => worker.concurrencyMode() === "global");
      const c = addSession("C");
      addMessage(c.id, "C1");
      worker.wake();
      assert.equal(turns.includes("C1"), false);
      releaseB();
      await worker.idle();
      assert.deepEqual(turns, ["A1", "B1", "A2", "C1"]);
      assert.equal(sameSessionOverlap, false);
      assert.deepEqual(listMessages(database, a.id).filter((row) => row.direction === "user").map((row) => row.state), ["failed", "completed"]);
    } finally { await worker.stop(); }
    const restarted = new ConversationWorker(database, home, runtime);
    assert.equal(restarted.concurrencyMode(), "global");
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
