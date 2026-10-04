import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "./sqlite-store.js";

import { RuntimeFailure } from "../agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime.js";
import { ClaudeRuntime } from "../claude-runtime.js";
import { CodexRuntime } from "../codex-runtime.js";
import { ConversationWorker } from "../conversation-worker.js";
import { archiveMessage, claimNextMessage, createSession, listMessages, markRuntimeStarted, openDatabase, upsertUser } from "../database.js";
import { start, startTransport } from "../index.js";
import { OpenCodeRuntime } from "../opencode-runtime.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../transport.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000",
  "POSTGRES_URL=postgresql://inoai_sync:secret@example.test:5432/app", "AGENT_INSTANCE_ID=agent-test"].join("\n");

class FakeTransport implements ChatTransport {
  private incoming?: (message: IncomingMessage) => void;
  private onControl?: (control: ThreadControl) => Promise<void>;
  private count = 0;
  readonly sent: string[] = [];
  start(onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.incoming = onIncoming;
    this.onControl = onControl;
    return Promise.resolve(onReady?.()).then(() => {});
  }
  emit(message: IncomingMessage): void { this.incoming?.(message); }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "thread-a",
      parentConversationId: "channel", externalUserId: "owner", conversationOwnedByBot: true,
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> { return `thread-${++this.count}`; }
  async deleteConversation(): Promise<void> {}
  async sendMessage(_conversationId: string, text: string): Promise<string> { this.sent.push(text); return `sent-${this.sent.length}`; }
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

async function startWithTestStore(directory: string): Promise<Awaited<ReturnType<typeof start>> & { database: import("node:sqlite").DatabaseSync }> {
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  const instance = await start(directory, undefined, () => sqliteStore(database));
  const release = instance.release;
  instance.release = async () => { await release(); database.close(); };
  return Object.assign(instance, { database });
}

test("transport wakes one global FIFO worker; duplicates do not run twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env);
    const instance = await startWithTestStore(directory);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const turns: string[] = [];
    let active = 0;
    let maxActive = 0;
    let created = 0;
    const runtime: AgentRuntime = {
      displayName: "Codex", loginHint: "codex login",
      async createSession() { return `codex-${++created}`; }, async resumeSession() {},
      async *runTurn(_sessionId, prompt): AsyncGenerator<RuntimeEvent> {
        active++; maxActive = Math.max(maxActive, active); turns.push(prompt);
        try { if (prompt === "first") await firstGate; yield { type: "answer", text: `answer:${prompt}` }; }
        finally { active--; }
      },
      async cancel() { releaseFirst(); }, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(sqliteStore(instance.database), instance.runtimeHome, runtime, "codex");
    try {
      await startTransport(instance, undefined, transport, undefined, worker, sqliteStore(instance.database));
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
    const instance = await startWithTestStore(directory);
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
      displayName: "Codex", loginHint: "codex login",
      async createSession() { return "new-codex-session"; }, async resumeSession() {},
      async *runTurn(_id, prompt) {
        turns.push(prompt);
        await new Promise<void>((resolve) => { gates.set(prompt, resolve); });
        yield { type: "answer" as const, text: `late:${prompt}` };
      },
      async cancel(id) { cancels.push(id); }, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(sqliteStore(instance.database), instance.runtimeHome, runtime, "codex");
    try {
      worker.enablePerSessionConcurrency();
      await startTransport(instance, undefined, transport, undefined, worker, sqliteStore(instance.database));
      await until(() => gates.has("a1") && gates.has("b1"));
      const before = instance.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'user'").get()?.count;
      assert.match(await transport.control("status"), /Queued: 1; running: 1/);
      assert.match(await transport.control("status", { externalUserId: "intruder" }), /only in your active/);
      assert.match(await transport.control("reset", { parentConversationId: "status" }), /only in your active/);
      assert.match(await transport.control("cancel", { conversationId: "unbound-own-thread" }), /only in your active/);
      const wrongBot = "This thread belongs to another inoai bot. Choose that bot's /inoai command to control it.";
      assert.equal(await transport.control("reset", { conversationId: "other-bot-thread", conversationOwnedByBot: false }), wrongBot);
      assert.equal(await transport.control("status", { conversationId: "other-bot-thread", conversationOwnedByBot: false }), wrongBot);
      assert.match(await transport.control("cancel", { conversationId: "other-bot-thread", conversationOwnedByBot: false, externalUserId: "intruder" }), /only in your active/);
      assert.match(await transport.control("status", { conversationId: "other-bot-thread", conversationOwnedByBot: false, parentConversationId: "status" }), /only in your active/);
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'user'").get()?.count, before);
      assert.match(await transport.control("cancel"), /Cancellation requested/);
      assert.deepEqual(cancels, ["codex-a1"]);
      gates.get("a1")!();
      await until(() => gates.has("a2"));
      assert.equal(listMessages(instance.database, a.id).find((row) => row.body === "a1")?.state, "failed");
      assert.equal(listMessages(instance.database, b.id).find((row) => row.body === "b1")?.state, "processing");
      transport.emit(incoming("a3", "thread-a", "channel")); // Queued behind the active old turn.
      await until(() => listMessages(instance.database, a.id).filter((row) => row.direction === "user").length === 3);
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
      displayName: "Codex", loginHint: "codex login",
      async createSession() { throw new Error("Should not create a new Agent Session"); },
      async resumeSession(id) { assert.equal(id, "codex-before"); },
      async *runTurn(_id, prompt) { turns.push(prompt); yield { type: "answer" as const, text: "ok" }; },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(recovered), home, runtime, "codex");
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
      displayName: "Codex", loginHint: "codex login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn(_id, prompt) {
        if (prompt === "fail") throw new RuntimeFailure("usage");
        yield { type: "answer" as const, text: "done" };
      },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
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

test("a Session from another provider is refused without a runtime call until reset starts a configured-provider Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-mismatch-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env.replace("AGENT_PROVIDER=codex", "AGENT_PROVIDER=claude"));
    const instance = await startWithTestStore(directory);
    const old = createSession(instance.database, { user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread-a", initiating_external_message_id: "m1",
      agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
    archiveMessage(instance.database, { session_id: old.id, transport: "discord", workspace_id: "guild",
      external_message_id: "m1", external_author_id: "owner", user_id: instance.owner.id, direction: "user", body: "m1",
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    const calls: string[] = [];
    const runtime: AgentRuntime = {
      displayName: "Claude", loginHint: "claude /login",
      async createSession() { calls.push("create"); return "claude-session"; },
      async resumeSession(id) { calls.push(`resume:${id}`); },
      async *runTurn(id, prompt) { calls.push(`turn:${id}`); yield { type: "answer" as const, text: `answer:${prompt.includes("m3") ? "m3" : "?"}` }; },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(sqliteStore(instance.database), instance.runtimeHome, runtime, instance.configuration.agentProvider, () => {}, transport);
    const notice = "This thread belongs to a Codex session. Use /inoai reset to start a new Claude session here, or start a new thread.";
    try {
      await startTransport(instance, undefined, transport, undefined, worker, sqliteStore(instance.database));
      await worker.idle();
      transport.emit(incoming("m2", "thread-a", "channel"));
      await until(() => listMessages(instance.database, old.id).some((row) => row.body === "m2"));
      await worker.idle();
      assert.deepEqual(calls, []);
      const refused = listMessages(instance.database, old.id);
      assert.deepEqual(refused.filter((row) => row.direction === "user").map((row) => [row.body, row.state, row.failure_detail, row.runtime_started_at]),
        [["m1", "failed", "Agent provider mismatch; replay_safe=false", null], ["m2", "failed", "Agent provider mismatch; replay_safe=false", null]]);
      assert.deepEqual(refused.filter((row) => row.direction === "agent").map((row) => [row.body, row.delivery_state]),
        [[notice, "confirmed"], [notice, "confirmed"]]);
      assert.deepEqual(transport.sent, [notice, notice]);
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'turn_failed' AND detail = 'reason=provider_mismatch; attempts=0'").get()?.count, 2);

      assert.match(await transport.control("reset"), /Session reset/);
      transport.emit(incoming("m3", "thread-a", "channel"));
      await until(() => calls.length === 2);
      await worker.idle();
      assert.deepEqual(calls, ["create", "turn:claude-session"]);
      const sessions = instance.database.prepare("SELECT id, state, agent_provider, agent_session_id, deleted_at FROM sessions WHERE conversation_id = 'thread-a' ORDER BY id").all() as Array<Record<string, unknown>>;
      assert.equal(sessions.length, 2);
      assert.deepEqual([sessions[0]?.state, sessions[0]?.agent_provider, sessions[0]?.deleted_at], ["ended", "codex", null]);
      assert.deepEqual([sessions[1]?.state, sessions[1]?.agent_provider, sessions[1]?.agent_session_id], ["active", "claude", "claude-session"]);
      assert.equal(listMessages(instance.database, old.id).length, 4); // The old archive is retained.
      assert.equal(listMessages(instance.database, Number(sessions[1]?.id)).find((row) => row.body === "m3")?.state, "completed");
      assert.equal(transport.sent.at(-1), "answer:m3");
    } finally { await worker.stop(); await transport.stop(); await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unrecognized stored provider is never echoed into the mismatch notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-unknown-provider-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "m1",
      agent_provider: "@everyone toString", agent_session_id: "pending:m1", project_path: directory });
    archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: "m1", external_author_id: "owner", user_id: owner.id, direction: "user", body: "m1",
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    const runtime: AgentRuntime = {
      displayName: "Codex", loginHint: "codex login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() { throw new Error("Unexpected resume"); },
      async *runTurn() { throw new Error("Unexpected turn"); },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
    try {
      worker.wake();
      await worker.idle();
      assert.equal(listMessages(database, session.id).find((row) => row.direction === "agent")?.body,
        "This thread belongs to a session from a different agent provider. Use /inoai reset to start a new Codex session here, or start a new thread.");
    } finally { await worker.stop(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the mismatch notice names OpenCode for an OpenCode-bound thread and names the other provider in an OpenCode home", async () => {
  const cases = [
    { stored: "opencode", current: "codex", currentName: "Codex", notice: "This thread belongs to an OpenCode session. Use /inoai reset to start a new Codex session here, or start a new thread." },
    { stored: "opencode", current: "claude", currentName: "Claude", notice: "This thread belongs to an OpenCode session. Use /inoai reset to start a new Claude session here, or start a new thread." },
    { stored: "codex", current: "opencode", currentName: "OpenCode", notice: "This thread belongs to a Codex session. Use /inoai reset to start a new OpenCode session here, or start a new thread." },
    { stored: "claude", current: "opencode", currentName: "OpenCode", notice: "This thread belongs to a Claude session. Use /inoai reset to start a new OpenCode session here, or start a new thread." },
  ] as const;
  for (const { stored, current, currentName, notice } of cases) {
    const directory = await mkdtemp(join(tmpdir(), "inoai-worker-opencode-mismatch-"));
    try {
      const home = await bootstrapRuntimeHome(directory);
      const database = openDatabase(home);
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
        display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "m1",
        agent_provider: stored, agent_session_id: `${stored}-session`, project_path: directory });
      archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: "m1", external_author_id: "owner", user_id: owner.id, direction: "user", body: "m1",
        reply_to_external_message_id: null, in_reply_to_message_id: null });
      const runtime: AgentRuntime = {
        displayName: currentName, loginHint: "login",
        async createSession() { throw new Error("Unexpected create"); }, async resumeSession() { throw new Error("Unexpected resume"); },
        async *runTurn() { throw new Error("Unexpected turn"); },
        async cancel() {}, health() { return { state: "ready" }; }, async close() {},
      };
      const worker = new ConversationWorker(sqliteStore(database), home, runtime, current);
      try {
        worker.wake();
        await worker.idle();
        const rows = listMessages(database, session.id);
        assert.equal(rows.find((row) => row.direction === "user")?.failure_detail, "Agent provider mismatch; replay_safe=false");
        assert.equal(rows.find((row) => row.direction === "agent")?.body, notice);
      } finally { await worker.stop(); database.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a missing runtime session fails once and tells the owner to reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-missing-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "lost",
      agent_provider: "claude", agent_session_id: "claude-session", project_path: directory });
    archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: "lost", external_author_id: "owner", user_id: owner.id, direction: "user", body: "lost",
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    let attempts = 0;
    const runtime: AgentRuntime = {
      displayName: "Claude", loginHint: "claude /login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() { attempts++; throw new RuntimeFailure("session_missing"); },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "claude");
    try {
      worker.wake();
      await worker.idle();
      assert.equal(attempts, 1);
      const rows = listMessages(database, session.id);
      assert.match(rows.find((row) => row.direction === "user")?.failure_detail ?? "", /Runtime session_missing; replay_safe=false/);
      assert.equal(rows.find((row) => row.direction === "agent")?.body,
        "This thread's Claude session could not be found. Use /inoai reset to start a new session.");
    } finally { await worker.stop(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Runs one failing Turn through the worker with the real adapter's notice identity; no CLI is spawned.
async function failedTurnNotice(provider: "codex" | "claude" | "opencode", kind: RuntimeFailure["kind"]) {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-notice-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
      display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "turn",
      agent_provider: provider, agent_session_id: `${provider}-session`, project_path: directory });
    archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
      external_message_id: "turn", external_author_id: "owner", user_id: owner.id, direction: "user", body: "turn",
      reply_to_external_message_id: null, in_reply_to_message_id: null });
    const adapter: AgentRuntime = provider === "codex" ? new CodexRuntime({} as never) : provider === "claude" ? new ClaudeRuntime() : new OpenCodeRuntime();
    let attempts = 0;
    const runtime: AgentRuntime = {
      displayName: adapter.displayName, loginHint: adapter.loginHint, authenticationNotice: adapter.authenticationNotice,
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() { attempts++; throw new RuntimeFailure(kind); },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const transport = new FakeTransport();
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, provider, () => {}, transport);
    try {
      worker.enablePerSessionConcurrency();
      worker.wake();
      await worker.idle();
      const user = listMessages(database, session.id).find((row) => row.direction === "user");
      return { sent: transport.sent, attempts, state: user?.state, failureDetail: user?.failure_detail, mode: worker.concurrencyMode() };
    } finally { await worker.stop(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("authentication and usage failures post the fixed provider-worded notice once without replay or FIFO fallback", async () => {
  const expected = {
    codex: {
      authentication: "Codex sign-in needs attention. Run codex login locally, then send a fresh request.",
      usage: "Codex usage is unavailable. Check your account locally, then send a fresh request.",
    },
    claude: {
      authentication: "Claude sign-in needs attention. Run claude /login locally, then send a fresh request.",
      usage: "Claude usage is unavailable. Check your account locally, then send a fresh request.",
    },
    opencode: {
      authentication: "OpenCode could not authenticate with its configured provider, or the free tier refused the request. Check opencode auth login locally, then send a fresh request.",
      usage: "OpenCode usage is unavailable. Check your account locally, then send a fresh request.",
    },
  } as const;
  for (const provider of ["codex", "claude", "opencode"] as const) {
    for (const kind of ["authentication", "usage"] as const) {
      const result = await failedTurnNotice(provider, kind);
      assert.deepEqual(result, { sent: [expected[provider][kind]], attempts: 1, state: "failed",
        failureDetail: `Runtime ${kind}; replay_safe=false`, mode: "per-session" }, `${provider} ${kind}`);
    }
  }
});

test("other failure kinds keep the generic notices and the existing FIFO fallback", async () => {
  assert.deepEqual(await failedTurnNotice("opencode", "uncertain"), {
    sent: ["I can't confirm whether that turn completed. I won't replay it automatically. Please check the local archive."],
    attempts: 1, state: "failed", failureDetail: "Runtime uncertain; replay_safe=false", mode: "global" });
  assert.deepEqual(await failedTurnNotice("claude", "cancelled"), {
    sent: ["I couldn't complete that turn safely. Please check the local archive before sending a new request."],
    attempts: 1, state: "failed", failureDetail: "Runtime cancelled; replay_safe=false", mode: "per-session" });
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
      displayName: "Codex", loginHint: "codex login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() { entered(); await cancelled; throw new RuntimeFailure("cancelled"); },
      async cancel() { cancel(); }, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
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
      displayName: "Codex", loginHint: "codex login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() {
        attempts++;
        if (closed) retryAfterClose = true;
        throw new RuntimeFailure("pre_start", true);
      },
      async cancel() {}, health() { return { state: "ready" }; }, async close() { closed = true; },
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
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
      displayName: "Codex", loginHint: "codex login",
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
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
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
    const restarted = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
    assert.equal(restarted.concurrencyMode(), "global");
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrency fallback log names the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-worker-runtime-name-"));
  const warn = console.warn;
  const warnings: unknown[] = [];
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const runtime: AgentRuntime = {
      displayName: "Claude", loginHint: "claude /login",
      async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
      async *runTurn() { throw new Error("Unexpected turn"); },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
    console.warn = (message: unknown) => { warnings.push(message); };
    worker.enablePerSessionConcurrency();
    worker.fallbackToGlobal();
    console.warn = warn;
    assert.deepEqual(warnings, ["Claude cross-session concurrency disabled; using global FIFO"]);
    await worker.stop();
    database.close();
  } finally {
    console.warn = warn;
    await rm(directory, { recursive: true, force: true });
  }
});
