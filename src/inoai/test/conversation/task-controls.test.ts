import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start, startTransport } from "../../app.js";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import type { TaskOperationsStore } from "../../connectors/persistence/sqlite/operational-store.js";
import type { OperationalStore } from "../../persistence/operational-store.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../../transport/ports.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");

class TaskTransport implements ChatTransport {
  private incoming?: (message: IncomingMessage) => void;
  private onControl?: (control: ThreadControl) => Promise<void>;
  sent: string[] = [];
  deletedMessages: string[] = [];
  deletedThreads: string[] = [];
  failThread = false;
  private threadCount = 0;
  async start(onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void,
    onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.incoming = onIncoming;
    this.onControl = onControl;
    await onReady?.();
  }
  emit(message: IncomingMessage): void { this.incoming?.(message); }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "channel", parentConversationId: null,
      guildTextChannelId: "channel", externalUserId: "owner", conversationOwnedByBot: false,
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> {
    if (this.failThread) throw new Error("Missing permission");
    return ++this.threadCount === 1 ? "task-thread" : `task-thread-${this.threadCount}`;
  }
  async deleteConversation(conversationId: string): Promise<void> { this.deletedThreads.push(conversationId); }
  async deleteMessage(_conversationId: string, messageId: string): Promise<void> { this.deletedMessages.push(messageId); }
  async sendMessage(_conversationId: string, text: string): Promise<string> { this.sent.push(text); return `sent-${this.sent.length}`; }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: "ready", botUserId: "inoai" }; }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

test("Task controls authorize the owner, create a thread, and keep steering out of chat turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-controls-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const transport = new TaskTransport();
      const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
        createSession: async () => "runtime-session", resumeSession: async () => {}, cancel: async () => {},
        health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(): AsyncIterable<RuntimeEvent> { yield { type: "answer", text: "Done" }; } };
      const runner = new TaskRunExecutor(instance.store as OperationalStore & TaskOperationsStore,
        runtime, instance.runtimeHome, transport, { reserveTaskRun: async () => () => {} }, "codex");
      await startTransport(instance, undefined, transport, undefined, undefined, undefined, runner);
      const create = { taskGoal: "Write a report", taskType: "recurring" as const, intervalSeconds: 3600 };
      assert.match(await transport.control("task-create", { ...create, externalUserId: "stranger" }), /unavailable/);
      assert.match(await transport.control("task-create", { ...create, workspaceId: null }), /unavailable/);
      assert.match(await transport.control("task-create", { ...create, conversationId: "ordinary-thread", parentConversationId: "channel" }), /unavailable/);
      assert.equal((await instance.store.listTasks?.())?.length, 0);
      assert.equal(transport.sent.length, 0);

      transport.failThread = true;
      assert.match(await transport.control("task-create", create), /creation failed/);
      assert.equal((await instance.store.listTasks?.())?.length, 0);
      assert.deepEqual(transport.deletedMessages, ["sent-1"]);
      assert.deepEqual(transport.deletedThreads, []);
      transport.failThread = false;

      assert.match(await transport.control("task-create", create), /Task #1 created: https:\/\/discord.com\/channels\/guild\/task-thread/);
      const task = (await instance.store.listTasks?.())?.[0];
      assert.ok(task);
      const session = await instance.store.getSession(task.session_id);
      assert.equal(session?.conversation_id, "task-thread");
      assert.equal(session?.parent_conversation_id, "channel");
      assert.match(await transport.control("task-list"), /#1 recurring active; next: <t:\d+:f>; https:\/\/discord.com\/channels\/guild\/task-thread/);
      assert.match(await transport.control("task-pause", { taskId: task.id }), /paused/);
      assert.equal((await instance.store.getTask?.(task.id))?.state, "paused");
      assert.match(await transport.control("task-resume", { conversationId: "task-thread", parentConversationId: "channel" }), /resumed/);
      assert.match(await transport.control("task-create", { taskGoal: "Once", taskType: "one_time" }), /Task #2 created/);
      assert.equal((await instance.store.getTask?.(2))?.next_due_at, null);
      assert.match(await transport.control("task-run", { taskId: 2, externalUserId: "stranger" }), /unavailable/);
      assert.equal((await instance.store.listTaskRuns?.(2))?.length, 0);
      assert.match(await transport.control("task-run", { taskId: 2 }), /run started/);
      await until(async () => (await instance.store.getTaskRun?.(1))?.state === "completed");
      assert.match(await transport.control("task-cancel", { taskId: task.id, externalUserId: "stranger" }), /unavailable/);
      await runner.stop();

      const incoming: IncomingMessage = { transport: "discord", workspaceId: "guild", conversationId: "task-thread",
        parentConversationId: "channel", externalMessageId: "steer-1", externalUserId: "owner", body: "Use Markdown",
        replyToExternalMessageId: null, mentionedUserIds: [], mentionedBotUserIds: [], botUserId: "inoai", authorIsBot: false };
      transport.emit(incoming);
      await until(async () => (await instance.store.listMessages(task.session_id)).length === 1);
      assert.equal((await instance.store.listMessages(task.session_id))[0]?.state, "completed");
      assert.equal(await instance.store.chatBusy(), false);
      transport.emit({ ...incoming, externalMessageId: "steer-2", externalUserId: "stranger" });
      transport.emit({ ...incoming, externalMessageId: "steer-3", authorIsBot: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await instance.store.listMessages(task.session_id)).length, 1);
      assert.match(await transport.control("reset", { conversationId: "task-thread", parentConversationId: "channel" }), /Use \/inoai task controls/);
      assert.match(await transport.control("task-cancel", { taskId: task.id }), /cancelled/);
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Task setup failure deletes its new thread and starter message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-setup-failure-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const transport = new TaskTransport();
      await startTransport(instance, undefined, transport, undefined, undefined,
        { ...instance.store, async createTask() { throw new Error("Database failed"); } });
      assert.match(await transport.control("task-create", { taskGoal: "Once", taskType: "one_time" }), /creation failed/);
      assert.deepEqual(transport.deletedThreads, ["task-thread"]);
      assert.deepEqual(transport.deletedMessages, ["sent-1"]);
      assert.equal((await instance.store.listTasks?.())?.length, 0);
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
