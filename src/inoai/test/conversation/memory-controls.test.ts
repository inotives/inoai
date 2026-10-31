import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start, startTransport } from "../../app.js";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import { MemoryReviewScheduler } from "../../memory/memory-review-scheduler.js";
import type { SchedulerClock } from "../../memory/memory-review-scheduler.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../../transport/ports.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=claude",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");

class ControlTransport implements ChatTransport {
  private onControl?: (control: ThreadControl) => Promise<void>;
  async start(_onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void,
    onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.onControl = onControl;
    await onReady?.();
  }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "status", parentConversationId: null,
      guildTextChannelId: "status", externalUserId: "owner", conversationOwnedByBot: false,
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> { return "thread"; }
  async deleteConversation(): Promise<void> {}
  async sendMessage(): Promise<string> { return "sent"; }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: "ready", botUserId: "inoai" }; }
}

const clock: SchedulerClock = { now: () => new Date(2026, 9, 3, 5, 0), setInterval: () => 0, clearInterval: () => undefined };
const reviewRuntime = () => {
  const state = { reviews: 0 };
  const runtime: AgentRuntime = { displayName: "Claude", loginHint: "none",
    createSession: async () => "runtime-session", resumeSession: async () => {}, cancel: async () => {},
    health: () => ({ state: "ready" }), close: async () => {},
    async *runTurn(): AsyncIterable<RuntimeEvent> { yield { type: "answer", text: "Done" }; },
    async review(prompt) {
      state.reviews++;
      return prompt.includes("combine the window notes") ? '{"recap": "A recap.", "actions": []}' : '{"notes": "window notes"}';
    } };
  return { runtime, state };
};

async function withInstance(fn: (instance: Awaited<ReturnType<typeof start>>, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-memory-controls-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try { await fn(instance, directory); } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("memory list shows kinds and short bodies, hides secret-like bodies, and forget soft-deletes known ids only", async () => {
  await withInstance(async (instance) => {
    const { store } = instance;
    const manual = { source_message_id: null, created_by_user_id: instance.owner.id, review_id: null, origin: "manual" as const };
    const core = await store.createMemory({ ...manual, body: "Answer in British English.", kind: "core" });
    const long = await store.createMemory({ ...manual, body: `Prefers ${"very ".repeat(30)}short replies.` });
    const secret = await store.createMemory({ ...manual, body: "The deploy password: hunter2-secret-value" });
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);

    const list = await transport.control("memory-list");
    const lines = list.split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], `#${core.id} core: Answer in British English.`);
    assert.match(lines[1]!, new RegExp(`^#${long.id} topic: Prefers very `));
    assert.ok(lines[1]!.length < 100 && lines[1]!.endsWith("…"));
    assert.equal(lines[2], `#${secret.id} topic: [hidden: may contain a secret]`);
    assert.doesNotMatch(list, /hunter2/);

    assert.match(await transport.control("memory-forget", { memoryId: 999 }), /Memory not found/);
    assert.match(await transport.control("memory-forget"), /Memory not found/);
    assert.equal((await store.listMemories()).length, 3);
    assert.equal(await transport.control("memory-forget", { memoryId: long.id }), `Memory #${long.id} forgotten.`);
    assert.deepEqual((await store.listMemories()).map((memory) => memory.id), [core.id, secret.id]);
    assert.match(await transport.control("memory-forget", { memoryId: long.id }), /Memory not found/);
    const database = openDatabase(instance.runtimeHome);
    try {
      const row = database.prepare("SELECT state, deleted_at, deleted_by, updated_by FROM memories WHERE id = ?").get(long.id) as Record<string, unknown>;
      assert.equal(row.state, "deleted");
      assert.ok(row.deleted_at);
      assert.equal(row.deleted_by, "user:owner");
      assert.equal(row.updated_by, "user:owner");
    } finally { database.close(); }

    await store.softDeleteMemory(core.id);
    await store.softDeleteMemory(secret.id);
    assert.equal(await transport.control("memory-list"), "No active Memories.");
  });
});

test("memory review starts a cycle when idle and refuses while a Task run or chat is busy", async () => {
  await withInstance(async (instance, directory) => {
    const { store } = instance;
    const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread-1", initiating_external_message_id: "start-1",
      agent_provider: "claude", agent_session_id: "claude-1", project_path: directory });
    let count = 0;
    const add = (direction: "user" | "agent", state: "completed" | "pending" = "completed") => store.archiveMessage({
      session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: `message-${++count}`,
      external_author_id: direction === "user" ? "owner" : null, user_id: direction === "user" ? instance.owner.id : null,
      direction, body: direction === "user" ? "I like tabs." : "Noted.", reply_to_external_message_id: null, in_reply_to_message_id: null, state });
    await add("user");
    await add("agent");
    const { runtime, state } = reviewRuntime();
    const scheduler = new MemoryReviewScheduler(store, runtime, { reviewTime: "06:00", maxChars: 20_000, clock });
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport, undefined, undefined, undefined, undefined, undefined, undefined, undefined, scheduler);
    const cycles = async () => (await store.listEvents()).filter((event) => event.event_type === "memory_review_cycle").map((event) => event.detail);
    try {
      assert.match(await transport.control("memory-review"), /unavailable right now/);
      scheduler.start();
      await scheduler.idle();
      // Before the daily review time nothing has run.
      assert.deepEqual([await cycles(), state.reviews], [[], 0]);

      assert.match(await transport.control("memory-review"), /Memory Review started for 1 Session\./);
      await scheduler.idle();
      assert.deepEqual(await cycles(), ["trigger=owner; date=2026-10-03; enqueued=1"]);
      assert.ok(state.reviews > 0);
      assert.match(await transport.control("memory-review"), /nothing new to review/);

      const release = await scheduler.pauseForTask();
      assert.match(await transport.control("memory-review"), /Chat or a Task Run is active/);
      release();
      await scheduler.idle();

      await add("user", "pending");
      const reviews = state.reviews;
      const before = (await cycles()).length;
      assert.match(await transport.control("memory-review"), /Chat or a Task Run is active/);
      await scheduler.idle();
      assert.deepEqual([(await cycles()).length, state.reviews], [before, reviews]);
    } finally { await scheduler.stop(); }
  });
});

test("a failing manual review cycle reports failure and never leaves the scheduler held", async () => {
  await withInstance(async (instance) => {
    const { runtime } = reviewRuntime();
    let failSessions = true;
    let enterCycle!: () => void;
    const entered = new Promise<void>((resolve) => { enterCycle = resolve; });
    let releaseCycle!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCycle = resolve; });
    let sessionCalls = 0;
    const store = new Proxy(instance.store, { get(target, property, receiver) {
      if (property === "listSessions") return async () => {
        sessionCalls++;
        if (!failSessions) return target.listSessions();
        enterCycle();
        await gate;
        throw new Error("SQLITE_BUSY");
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const failures: Error[] = [];
    const scheduler = new MemoryReviewScheduler(store, runtime, { reviewTime: "06:00", maxChars: 20_000, clock,
      onFailure: (error) => failures.push(error) });
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport, undefined, undefined, undefined, undefined, undefined, undefined, undefined, scheduler);
    try {
      scheduler.start();
      await scheduler.idle();
      const reply = transport.control("memory-review");
      await entered;
      const paused = scheduler.pauseForTask();
      releaseCycle();
      assert.equal(await reply, "Memory Review failed. Try again later.");
      const release = await paused;
      assert.deepEqual(failures.map((error) => error.message), ["SQLITE_BUSY"]);
      failSessions = false;
      release();
      await scheduler.idle();
      const calls = sessionCalls;
      assert.match(await transport.control("memory-review"), /nothing new to review/);
      assert.equal(sessionCalls, calls + 1);
      assert.deepEqual((await instance.store.listEvents()).filter((event) => event.event_type === "memory_review_cycle").map((event) => event.detail),
        ["trigger=owner; date=2026-10-03; enqueued=0"]);
    } finally { await scheduler.stop(); }
  });
});

test("memory list, forget, and review refuse non-owners and other workspaces", async () => {
  await withInstance(async (instance) => {
    const { store } = instance;
    const memory = await store.createMemory({ body: "Prefers tabs.", source_message_id: null, created_by_user_id: instance.owner.id, review_id: null, origin: "manual" });
    let requests = 0;
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { requestCycle: async () => { requests++; return { state: "started", enqueued: 0 }; } });
    for (const overrides of [{ externalUserId: "stranger" }, { workspaceId: "other-guild" }, { workspaceId: null }]) {
      for (const command of ["memory-list", "memory-forget", "memory-review"] as const) {
        const answer = await transport.control(command, { ...overrides, memoryId: memory.id });
        assert.equal(answer, "Memory control unavailable in this channel.");
      }
    }
    assert.deepEqual((await store.listMemories()).map((item) => item.id), [memory.id]);
    assert.equal(requests, 0);
    assert.match(await transport.control("memory-review"), /nothing new to review/);
    assert.equal(requests, 1);
  });
});
