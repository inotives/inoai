import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { ChannelType, Events, MessageFlags } from "discord.js";
import type { Client } from "discord.js";

import type { AgentRuntime } from "../agent-runtime.js";
import { createChatTransport, DiscordTransport } from "../transport.js";
import type { IncomingMessage } from "../transport.js";
import { archiveMessage, claimLegacyApprovalNotice, createSession, legacyApprovalNotices, listEvents, listMessages, openDatabase } from "../database.js";
import { run, start, startTransport } from "../index.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { SchedulerClock } from "../memory/memory-review-scheduler.js";
import { sqliteStore } from "../test/sqlite-store.js";

class FakeClient extends EventEmitter {
  user = { id: "inoai" };
  registeredCommands: unknown[] = [];
  registeredGuild: string | undefined;
  application = { commands: { create: async (command: unknown, guildId: string) => {
    this.registeredCommands = [command];
    this.registeredGuild = guildId;
  } } };
  destroyed = false;
  failSend = false;
  failThread = false;
  sendStarted?: () => void;
  sendGate?: Promise<void>;
  sent: unknown[] = [];
  sentChannelIds: string[] = [];
  threadCount = 0;
  deletedThreads: string[] = [];
  editedApprovals: string[] = [];
  threadStarted?: () => void;
  threadGate?: Promise<void>;
  channels = { fetch: async (id: string) => ["parent", "channel", "another-channel", "status"].includes(id) ? {
    type: ChannelType.GuildText,
    guildId: "guild",
    threads: { create: async (options: unknown) => { this.threadStarted?.(); await this.threadGate; if (this.failThread) throw new Error("thread creation failed"); this.sent.push(options); return { id: ++this.threadCount === 1 ? "thread" : `thread-${this.threadCount}` }; } },
    send: async (options: unknown) => { this.sendStarted?.(); await this.sendGate; if (this.failSend) throw new Error("send failed"); this.sentChannelIds.push(id); this.sent.push(options); return { id: `sent-${this.sent.length}` }; },
  } : {
    isThread: () => id.startsWith("thread"),
    isTextBased: () => true,
    messages: { fetch: async (messageId: string) => ({ author: { id: "inoai" }, edit: async (options: unknown) => { this.editedApprovals.push(messageId); this.sent.push(options); } }) },
    delete: async () => { this.deletedThreads.push(id); },
    isSendable: () => true,
    send: async (options: unknown) => { if (this.failSend) throw new Error("send failed"); this.sent.push(options); return { id: `sent-${this.sent.length}` }; },
  } };
  async login(): Promise<string> {
    this.emit(Events.ClientReady);
    return "connected";
  }
  async destroy(): Promise<void> { this.destroyed = true; }
}

test("Discord gateway lifecycle and message mapping use a fake client", async () => {
  const fake = new FakeClient();
  const transport = new DiscordTransport("", fake as unknown as Client);
  const incoming: IncomingMessage[] = [];
  let readyCount = 0;
  await transport.start((message) => incoming.push(message), () => { readyCount++; });
  assert.deepEqual(transport.health(), { state: "ready", botUserId: "inoai" });

  const message = {
    guildId: "guild", channelId: "thread", id: "message", author: { id: "owner", bot: false }, content: "<@inoai> <@friend> hello",
    channel: { isThread: () => true, parentId: "parent" },
    reference: { messageId: "previous" },
    mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }], ["friend", { id: "friend", bot: false }]]) },
  };
  fake.emit(Events.MessageCreate, message);
  assert.deepEqual(incoming, [{
    transport: "discord", workspaceId: "guild", conversationId: "thread", parentConversationId: "parent",
    externalMessageId: "message", externalUserId: "owner", body: "<@inoai> <@friend> hello", replyToExternalMessageId: "previous",
    mentionedUserIds: ["inoai", "friend"], mentionedBotUserIds: ["inoai"], botUserId: "inoai", authorIsBot: false,
  }]);

  assert.equal(await transport.createConversation("parent", "message", "task"), "thread");
  assert.equal(await transport.sendMessage("thread", "answer", "previous"), "sent-2");
  assert.equal(await transport.publishHealth("channel", "inoai is online", "guild"), "sent-3");
  await assert.rejects(transport.publishHealth("channel", "inoai is online", "other-guild"), /configured guild/);
  assert.deepEqual(fake.sent, [
    { name: "task", startMessage: "message" },
    { content: "answer", allowedMentions: { parse: [], repliedUser: false }, reply: { messageReference: "previous" } },
    { content: "inoai is online" },
  ]);

  fake.emit(Events.ShardReconnecting);
  assert.equal(transport.health().state, "reconnecting");
  fake.emit(Events.ShardReady);
  assert.equal(transport.health().state, "ready");
  assert.equal(readyCount, 1);
  fake.emit(Events.MessageCreate, { ...message, id: "recovered" });
  assert.equal(incoming.at(-1)?.externalMessageId, "recovered");
  fake.emit(Events.ShardReconnecting);
  fake.emit(Events.ShardResume);
  assert.equal(transport.health().state, "ready");
  await transport.stop();
  assert.equal(transport.health().state, "stopped");
  assert.equal(fake.destroyed, true);
  fake.emit(Events.ClientReady);
  assert.equal(transport.health().state, "stopped");
});

test("native inoai interaction is deferred privately and routed without a message event", async () => {
  const fake = new FakeClient();
  const transport = new DiscordTransport("", fake as unknown as Client);
  const controls: string[] = [];
  const replies: unknown[] = [];
  await transport.start(() => { throw new Error("Slash command must not enter the message queue"); }, undefined, undefined,
    async (control) => { controls.push(`${control.command}:${control.conversationId}:${control.externalUserId}:${control.conversationOwnedByBot}`); await control.respond("ready"); });
  const interaction = (channelId: string, ownerId: string) => ({
    isChatInputCommand: () => true, commandName: "inoai", options: { getSubcommand: () => "status" },
    guildId: "guild", channelId, channel: { isThread: () => true, parentId: "channel", ownerId },
    user: { id: "owner" },
    deferReply: async (options: unknown) => { replies.push(options); },
    editReply: async (options: unknown) => { replies.push(options); },
  });
  fake.emit(Events.InteractionCreate, interaction("thread", "inoai"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls, ["status:thread:owner:true"]);
  assert.deepEqual(replies, [{ flags: MessageFlags.Ephemeral }, { content: "ready", allowedMentions: { parse: [] } }]);
  fake.emit(Events.InteractionCreate, interaction("other-thread", "other-bot"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls, ["status:thread:owner:true", "status:other-thread:owner:false"]);
  assert.deepEqual(replies.slice(2), [{ flags: MessageFlags.Ephemeral }, { content: "ready", allowedMentions: { parse: [] } }]);
  await transport.stop();
});

test("unrecoverable shard disconnect exposes an error", async () => {
  const fake = new FakeClient();
  const transport = new DiscordTransport("", fake as unknown as Client);
  await transport.start(() => undefined);
  fake.emit(Events.ShardDisconnect);
  assert.equal(transport.health().state, "error");
  fake.emit(Events.ShardReady);
  assert.equal(transport.health().state, "error");
  await transport.stop();
});

test("stop settles startup before the gateway becomes ready", async () => {
  class NoReadyClient extends FakeClient {
    override async login(): Promise<string> { return "connected"; }
  }
  const fake = new NoReadyClient();
  const transport = new DiscordTransport("", fake as unknown as Client);
  const starting = transport.start(() => undefined);
  await transport.stop();
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(transport.health().state, "stopped");
  assert.equal(fake.destroyed, true);
});

test("failed ready callback prevents a successful start", async () => {
  const fake = new FakeClient();
  const transport = new DiscordTransport("", fake as unknown as Client);
  await assert.rejects(transport.start(() => undefined, () => { throw new Error("health failed"); }), /health failed/);
  assert.equal(transport.health().state, "error");
  assert.equal(fake.destroyed, true);
});

test("provider selector creates the Discord adapter", () => {
  const fake = new FakeClient();
  const transport = createChatTransport({ chatProvider: "discord", discordBotToken: "" } as Parameters<typeof createChatTransport>[0], fake as unknown as Client);
  assert(transport instanceof DiscordTransport);
});

const validEnv = [
  "DISCORD_BOT_TOKEN=token",
  "DISCORD_GUILD_ID=guild",
  "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status",
  "CHAT_PROVIDER=discord",
  "AGENT_PROVIDER=codex",
  "POSTGRES_URL=postgresql://inoai_sync:secret@example.test:5432/app",
  "AGENT_INSTANCE_ID=agent-test",
  "MEMORY_REVIEW_TIME=06:00",
  "MEMORY_REVIEW_MAX_CHARS=20000",
].join("\n");

// Wired run() tests pin the review scheduler before the 06:00 review time with no timer, so no cycle or review can
// start whatever the time of day.
const beforeReviewTime = { schedulerClock: {
  now: () => new Date(2026, 9, 3, 5, 0), setInterval: () => undefined, clearInterval: () => {},
} satisfies SchedulerClock, storeFactory: (_pool: unknown, home: Awaited<ReturnType<typeof start>>["runtimeHome"]) => sqliteStore(openDatabase(home)) };

const fakeRuntime: AgentRuntime = {
  displayName: "Codex", loginHint: "codex login",
  async createSession() { return "fake-codex-thread"; }, async resumeSession() {},
  async *runTurn() { yield { type: "answer" as const, text: "ok" }; },
  async cancel() {}, health() { return { state: "ready" }; }, async close() {},
};

async function startWithTestStore(directory: string): Promise<Awaited<ReturnType<typeof start>> & { database: DatabaseSync }> {
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  const instance = await start(directory, undefined, () => sqliteStore(database));
  const release = instance.release;
  instance.release = async () => { await release(); database.close(); };
  return Object.assign(instance, { database });
}

test("plain reply pings are ignored while explicit top-level mentions create distinct threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-conversation-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    const { database } = instance;
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, instance.store);
      const incoming = (id: string) => ({
        guildId: "guild", channelId: "another-channel", id, author: { id: "owner", bot: false }, content: `<@inoai> ${id}`,
        channel: { isThread: () => false }, reference: null,
        mentions: {
          users: new Map([["inoai", { id: "inoai", bot: true }]]),
          parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]),
        },
      });
      const replyPing = incoming("reply-ping");
      fake.emit(Events.MessageCreate, {
        ...replyPing, content: "Just checking", reference: { messageId: "bot-post" },
        mentions: { users: replyPing.mentions.users, parsedUsers: new Map() },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fake.threadCount, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
      fake.emit(Events.MessageCreate, { ...incoming("status-request"), channelId: "status" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fake.threadCount, 0);
      fake.emit(Events.MessageCreate, incoming("first"));
      fake.emit(Events.MessageCreate, incoming("first"));
      await new Promise((resolve) => setImmediate(resolve));
      fake.emit(Events.MessageCreate, incoming("first"));
      fake.emit(Events.MessageCreate, incoming("second"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const sessions = database.prepare("SELECT * FROM sessions ORDER BY id").all() as Array<{ id: number; conversation_id: string; initiating_external_message_id: string; project_path: string }>;
      assert.deepEqual(sessions.map(({ conversation_id, initiating_external_message_id }) => [conversation_id, initiating_external_message_id]), [
        ["thread", "first"], ["thread-2", "second"],
      ]);
      assert(sessions.every((session) => session.project_path === directory));
      for (const session of sessions) {
        const messages = listMessages(database, session.id);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.external_message_id, session.initiating_external_message_id);
        assert.equal(messages[0]?.body, `<@inoai> ${session.initiating_external_message_id}`);
        assert.equal(messages[0]?.state, "pending");
      }
      assert.equal(fake.threadCount, 2);
      assert.deepEqual(fake.sentChannelIds, ["status"]);
      await transport.stop();
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed Discord thread creation leaves no Session or Message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-thread-create-failure-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      fake.failThread = true;
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(instance.database));
      fake.emit(Events.MessageCreate, {
        guildId: "guild", channelId: "another-channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
        channel: { isThread: () => false }, reference: null,
        mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 0);
      assert.equal(fake.threadCount, 0);
      await transport.stop();
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned thread messages queue once without a mention and keep cross-agent mentions in the owning session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-thread-ingestion-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(instance.database));
      const owner = { id: "owner", bot: false };
      const ownBot = { id: "inoai", bot: true };
      const otherBot = { id: "other-bot", bot: true };
      const incoming = (id: string, channelId: string, parentId: string | null, author = owner, mentions = new Map<string, typeof ownBot>()) => ({
        guildId: "guild", channelId, id, author, content: mentions.size ? `<@${[...mentions.keys()][0]}> ${id}` : id,
        channel: { isThread: () => parentId !== null, parentId },
        reference: id === "reply" ? { messageId: "initial" } : null,
        mentions: { parsedUsers: mentions },
      });

      fake.emit(Events.MessageCreate, incoming("initial", "channel", null, owner, new Map([["inoai", ownBot]])));
      await new Promise((resolve) => setImmediate(resolve));
      fake.emit(Events.MessageCreate, incoming("reply", "thread", "channel"));
      fake.emit(Events.MessageCreate, incoming("reply", "thread", "channel"));
      fake.emit(Events.MessageCreate, incoming("cross-agent", "thread", "channel", owner, new Map([["other-bot", otherBot]])));
      fake.emit(Events.MessageCreate, incoming("foreign-thread", "other-thread", "channel"));
      fake.emit(Events.MessageCreate, incoming("bot-authored", "thread", "channel", ownBot));
      fake.emit(Events.MessageCreate, incoming("wrong-user", "thread", "channel", { id: "stranger", bot: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const sessions = instance.database.prepare("SELECT id FROM sessions").all() as Array<{ id: number }>;
      assert.equal(sessions.length, 1);
      const messages = listMessages(instance.database, sessions[0]!.id);
      assert.deepEqual(messages.map((message) => [message.external_message_id, message.state, message.reply_to_external_message_id]), [
        ["initial", "pending", null], ["reply", "pending", "initial"], ["cross-agent", "pending", null],
      ]);
      assert(messages.every((message) => message.session_id === sessions[0]!.id && message.direction === "user"));
      assert.equal(fake.threadCount, 1);
      await transport.stop();
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed persistence removes the new thread so redelivery creates one bound conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-conversation-failure-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(instance.database));
      const incoming = {
        guildId: "guild", channelId: "channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
        channel: { isThread: () => false }, reference: null,
        mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
      };
      instance.database.exec("CREATE TEMP TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'session failed'); END");
      fake.emit(Events.MessageCreate, incoming);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
      assert.deepEqual(fake.deletedThreads, ["thread"]);
      instance.database.exec("DROP TRIGGER fail_session");
      fake.emit(Events.MessageCreate, incoming);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fake.threadCount, 2);
      assert.equal(instance.database.prepare("SELECT conversation_id FROM sessions").get()?.conversation_id, "thread-2");
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 1);
      await transport.stop();
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI shutdown drains an accepted request before closing SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-conversation-shutdown-"));
  const previousDirectory = process.cwd();
  const previousExitCode = process.exitCode;
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    process.chdir(directory);
    const fake = new FakeClient();
    let threadStarted!: () => void;
    let finishThread!: () => void;
    const creating = new Promise<void>((resolve) => { threadStarted = resolve; });
    fake.threadGate = new Promise<void>((resolve) => { finishThread = resolve; });
    fake.threadStarted = threadStarted;
    await run([], new DiscordTransport("token", fake as unknown as Client), fakeRuntime, beforeReviewTime);
    fake.emit(Events.MessageCreate, {
      guildId: "guild", channelId: "channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
      channel: { isThread: () => false }, reference: null,
      mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
    });
    await creating;
    process.emit("SIGTERM");
    finishThread();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await stat(home.lockFile).then(() => false, () => true)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    assert.deepEqual(fake.deletedThreads, []);
    const restarted = await startWithTestStore(directory);
    try {
      assert.equal(restarted.database.prepare("SELECT conversation_id FROM sessions").get()?.conversation_id, "thread");
      assert.equal(restarted.database.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 1);
    } finally {
      await restarted.release();
    }
  } finally {
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup announces once and archives one health Event across reconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(instance.database));
      assert.deepEqual(fake.sent, [{ content: "inoai is online" }]);
      assert.equal(fake.registeredGuild, "guild");
      assert.deepEqual((fake.registeredCommands[0] as { options: Array<{ name: string }> }).options.map((option) => option.name), ["status", "cancel", "reset"]);
      assert.deepEqual(fake.sentChannelIds, ["status"]);
      const event = listEvents(instance.database)[0];
      assert.equal(event.event_type, "startup_online");
      assert.equal(event.detail, "discord message sent-1");
      assert.equal(event.session_id, null);
      assert.equal(event.message_id, null);
      fake.emit(Events.ShardReconnecting);
      fake.emit(Events.ShardReady);
      fake.emit(Events.ClientReady);
      assert.equal(fake.sent.length, 1);
      assert.equal(listEvents(instance.database).length, 1);
      await transport.stop();
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy approval recovery is deferred with the SQLite UI archive", { skip: "operational startup no longer reads SQLite approvals" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-legacy-approval-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const first = await startWithTestStore(directory);
    const session = createSession(first.database, {
      user_id: first.owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
      conversation_id: "thread", initiating_external_message_id: "initial", agent_provider: "codex",
      agent_session_id: "legacy-thread", project_path: directory,
    });
    const request = archiveMessage(first.database, {
      session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "old-control",
      external_author_id: null, user_id: null, direction: "agent", body: "legacy prompt token=secret-123",
      reply_to_external_message_id: null, in_reply_to_message_id: null, state: "completed",
    });
    first.database.prepare(`INSERT INTO approvals (session_id, runtime_approval_id, request_message_id, summary, expires_at)
      VALUES (?, 'lost-json-rpc', ?, 'token=secret-123', unixepoch() + 3600)`).run(session.id, request.message!.id);
    const userMessage = archiveMessage(first.database, {
      session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "ordinary-user",
      external_author_id: "owner", user_id: first.owner.id, direction: "user", body: "ordinary user request",
      reply_to_external_message_id: null, in_reply_to_message_id: null, state: "completed",
    });
    first.database.prepare(`INSERT INTO approvals (session_id, runtime_approval_id, request_message_id, summary, expires_at, state)
      VALUES (?, 'previously-failed', ?, 'another unsafe preview', unixepoch() + 3600, 'failed')`).run(session.id, userMessage.message!.id);
    await first.release();

    const recovered = await startWithTestStore(directory);
    try {
      const approval = recovered.database.prepare("SELECT state, summary, resolution_message_id FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get();
      assert.equal(approval?.state, "failed");
      assert.equal(approval?.summary, "Legacy approval request redacted");
      assert.equal(recovered.database.prepare("SELECT summary FROM approvals WHERE runtime_approval_id = 'previously-failed'").get()?.summary, "Legacy approval request redacted");
      assert.equal(listMessages(recovered.database, session.id).find((message) => message.id === request.message!.id)?.body, "Legacy approval request redacted");
      assert.equal(listMessages(recovered.database, session.id).find((message) => message.external_message_id === "ordinary-user")?.body, "ordinary user request");
      assert.equal(listEvents(recovered.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      const fake = new FakeClient();
      const transport = await startTransport(recovered, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(recovered.database));
      assert.deepEqual(fake.editedApprovals, ["old-control"]);
      assert.deepEqual(fake.sent[0], { content: "A saved Codex approval could not be resumed after restart. No action was approved.", components: [] });
      assert(fake.sent.some((message) => JSON.stringify(message).includes("Please make a fresh request")));
      assert(!JSON.stringify(fake.sent).includes("secret-123"));
      assert.equal(typeof recovered.database.prepare("SELECT resolution_message_id FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get()?.resolution_message_id, "number");
      assert.equal(listMessages(recovered.database, session.id).filter((message) => message.body.includes("Please make a fresh request")).length, 1);
      assert.equal(fake.listenerCount(Events.InteractionCreate), 1);
      fake.emit(Events.InteractionCreate, { customId: "approve:lost-json-rpc", isChatInputCommand: () => false });
      assert.equal(recovered.database.prepare("SELECT state FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get()?.state, "failed");
      await transport.stop();
    } finally {
      await recovered.release();
    }

    const again = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(again, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(again.database));
      assert.deepEqual(fake.sent, [{ content: "inoai is online" }]);
      assert.equal(listEvents(again.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      assert.equal(again.database.prepare("SELECT state FROM sessions WHERE id = ?").get(session.id)?.state, "active");
      fake.emit(Events.MessageCreate, {
        guildId: "guild", channelId: "thread", id: "fresh-request", author: { id: "owner", bot: false }, content: "fresh request",
        channel: { isThread: () => true, parentId: "channel" }, reference: null, mentions: { parsedUsers: new Map() },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(listMessages(again.database, session.id).some((message) => message.external_message_id === "fresh-request"));
      await transport.stop();
    } finally {
      await again.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a claimed legacy notice is not resent after a crash before Discord delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-legacy-notice-crash-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const first = await startWithTestStore(directory);
    const session = createSession(first.database, {
      user_id: first.owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
      conversation_id: "thread", initiating_external_message_id: "initial", agent_provider: "codex",
      agent_session_id: "legacy-thread", project_path: directory,
    });
    first.database.prepare(`INSERT INTO approvals (session_id, runtime_approval_id, summary, expires_at)
      VALUES (?, 'lost-request', 'unsafe preview', unixepoch() + 3600)`).run(session.id);
    await first.release();

    const recovered = await startWithTestStore(directory);
    assert.equal(legacyApprovalNotices(recovered.database).length, 1);
    assert.equal(claimLegacyApprovalNotice(recovered.database, legacyApprovalNotices(recovered.database)[0]!.id), true);
    await recovered.release(); // Crash boundary: the claim committed, but Discord send never happened.

    const again = await startWithTestStore(directory);
    try {
      assert.equal(legacyApprovalNotices(again.database).length, 0);
      assert.equal(listEvents(again.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      const fake = new FakeClient();
      const transport = await startTransport(again, undefined, new DiscordTransport("token", fake as unknown as Client), undefined, undefined, sqliteStore(again.database));
      assert.deepEqual(fake.sent, [{ content: "inoai is online" }]);
      assert.equal(again.database.prepare("SELECT resolution_message_id FROM approvals").get()?.resolution_message_id, null);
      await transport.stop();
    } finally {
      await again.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection or health publish failure never archives an online Event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      class LoginFailure extends FakeClient {
        override async login(): Promise<string> { throw new Error("login failed"); }
      }
      const disconnected = new LoginFailure();
      await assert.rejects(startTransport(instance, undefined, new DiscordTransport("token", disconnected as unknown as Client), undefined, undefined, sqliteStore(instance.database)), /login failed/);
      assert.equal(disconnected.sent.length, 0);

      const failed = new FakeClient();
      failed.failSend = true;
      await assert.rejects(startTransport(instance, undefined, new DiscordTransport("token", failed as unknown as Client), undefined, undefined, sqliteStore(instance.database)), /send failed/);
      assert.equal(listEvents(instance.database).length, 0);
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown during an in-flight health post cannot archive an online Event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await startWithTestStore(directory);
    try {
      const fake = new FakeClient();
      let sendStarted!: () => void;
      let finishSend!: () => void;
      const sending = new Promise<void>((resolve) => { sendStarted = resolve; });
      fake.sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
      fake.sendStarted = sendStarted;
      const transport = new DiscordTransport("token", fake as unknown as Client);
      const starting = startTransport(instance, undefined, transport, undefined, undefined, sqliteStore(instance.database));
      const rejected = assert.rejects(starting);
      await sending;
      await transport.stop();
      finishSend();
      await rejected;
      assert.equal(listEvents(instance.database).length, 0);
    } finally {
      await instance.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI SIGTERM during the health post releases SQLite and the runtime lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  const previousDirectory = process.cwd();
  const previousExitCode = process.exitCode;
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    process.chdir(directory);
    const fake = new FakeClient();
    let sendStarted!: () => void;
    let finishSend!: () => void;
    const sending = new Promise<void>((resolve) => { sendStarted = resolve; });
    fake.sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
    fake.sendStarted = sendStarted;
    const running = run([], new DiscordTransport("token", fake as unknown as Client), fakeRuntime, beforeReviewTime);
    await sending;
    process.emit("SIGTERM");
    finishSend();
    await running;
    const restarted = await startWithTestStore(directory);
    try {
      assert.equal(listEvents(restarted.database).length, 0);
    } finally {
      await restarted.release();
    }
  } finally {
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI exits and releases the runtime lock after terminal Discord failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  const previousDirectory = process.cwd();
  const previousExitCode = process.exitCode;
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    process.chdir(directory);
    const fake = new FakeClient();
    await run([], new DiscordTransport("token", fake as unknown as Client), fakeRuntime, beforeReviewTime);
    fake.emit(Events.ShardDisconnect);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await stat(home.lockFile).then(() => false, () => true)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    assert.equal(process.exitCode, 1);
    const restarted = await startWithTestStore(directory);
    await restarted.release();
  } finally {
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude startup failure happens before any external connection and releases the runtime lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-claude-provider-"));
  const previousDirectory = process.cwd();
  const previousPath = process.env.PATH;
  try {
    // An empty PATH makes the installed `claude` unavailable without running the real CLI.
    process.env.PATH = directory;
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv.replace("AGENT_PROVIDER=codex", "AGENT_PROVIDER=claude"));
    process.chdir(directory);
    const fake = new FakeClient();
    let loggedIn = false;
    fake.login = async () => { loggedIn = true; return "connected"; };
    await assert.rejects(run([], new DiscordTransport("token", fake as unknown as Client), undefined, beforeReviewTime), /Claude CLI is unavailable/);
    assert.equal(loggedIn, false);
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    const restarted = await startWithTestStore(directory);
    await restarted.release();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing OpenCode CLI fails startup before any external connection and releases the runtime lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-opencode-provider-"));
  const previousDirectory = process.cwd();
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  try {
    // A PATH of an empty temp dir and a temp HOME keep any installed `opencode` and the owner's OpenCode folders out of reach.
    process.env.PATH = directory;
    process.env.HOME = join(directory, "home");
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv.replace("AGENT_PROVIDER=codex", "AGENT_PROVIDER=opencode"));
    process.chdir(directory);
    const fake = new FakeClient();
    let loggedIn = false;
    fake.login = async () => { loggedIn = true; return "connected"; };
    await assert.rejects(run([], new DiscordTransport("token", fake as unknown as Client), undefined, beforeReviewTime), /OpenCode CLI is unavailable/);
    assert.equal(loggedIn, false);
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    const restarted = await startWithTestStore(directory);
    await restarted.release();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

// A fake `claude` placed on PATH: it answers --version, `auth status --json` from status.json, and each -p Turn
// with one permission denial and an answer. Only the subscription fields matter; identity fields are sentinels.
const fakeClaudeScript = `
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv[0] === "--version") process.exit(0);
if (argv[0] === "auth") {
  const { status, exit } = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  process.stdout.write(JSON.stringify(status, null, 2) + "\\n");
  process.exit(exit);
}
const sid = argv[argv.findIndex((arg) => arg === "--session-id" || arg === "--resume") + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of [
    { type: "system", subtype: "init", session_id: sid, apiKeySource: "none" },
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    { type: "result", subtype: "success", is_error: false, result: "claude answer", session_id: sid, permission_denials: [{ tool_name: "Bash" }] },
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
});
`;

async function withFakeClaude(status: unknown, fn: (directory: string, home: Awaited<ReturnType<typeof bootstrapRuntimeHome>>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-claude-run-"));
  const bin = join(directory, "bin");
  const previousDirectory = process.cwd();
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const hadOauth = Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN");
  const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const previousExitCode = process.exitCode;
  try {
    await mkdir(bin);
    await writeFile(join(bin, "claude"), `#!${process.execPath}\n${fakeClaudeScript}`, { mode: 0o755 });
    await writeFile(join(bin, "status.json"), JSON.stringify({ status, exit: 0 }));
    process.env.PATH = bin;
    // run() starts the real Claude probe, which resolves ~/.claude through os.homedir() (HOME on macOS):
    // a temp HOME keeps it away from the developer's real CLI folders.
    await mkdir(join(directory, "home"));
    process.env.HOME = join(directory, "home");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv.replace("AGENT_PROVIDER=codex", "AGENT_PROVIDER=claude"));
    process.chdir(directory);
    await fn(directory, home);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (hadOauth) process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauth;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
}

const claudeSubscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "owner-sentinel@example.com", orgId: "org-sentinel", orgName: "Org Sentinel" };

test("Claude credential guard refuses an API key before Discord starts and releases the runtime lock", async () => {
  await withFakeClaude({ ...claudeSubscription, apiKeySource: "ANTHROPIC_API_KEY" }, async (directory, home) => {
    const fake = new FakeClient();
    let loggedIn = false;
    fake.login = async () => { loggedIn = true; return "connected"; };
    const error = await run([], new DiscordTransport("token", fake as unknown as Client), undefined, beforeReviewTime).then(() => assert.fail("expected refusal"), (failure: unknown) => failure as Error);
    assert.match(error.message, /Claude credential refused: an API key \(ANTHROPIC_API_KEY\)/);
    assert.equal(/sentinel/i.test(error.message), false);
    assert.equal(loggedIn, false);
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    const restarted = await startWithTestStore(directory);
    try {
      assert.equal(restarted.database.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 0);
    } finally { await restarted.release(); }
  });
});

test("Claude startup with the subscription login wires the runtime and a denied Turn posts the fixed notice", async () => {
  await withFakeClaude(claudeSubscription, async (directory, home) => {
    const fake = new FakeClient();
    const logged: unknown[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { logged.push(args); };
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await run([], new DiscordTransport("token", fake as unknown as Client), undefined, beforeReviewTime);
      fake.emit(Events.MessageCreate, {
        guildId: "guild", channelId: "channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
        channel: { isThread: () => false }, reference: null,
        mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
      });
      const sentText = () => JSON.stringify(fake.sent);
      for (let attempt = 0; attempt < 500 && !(sentText().includes("Use local Claude for the blocked action") && sentText().includes("claude answer")); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      process.emit("SIGTERM");
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await stat(home.lockFile).then(() => false, () => true)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.match(JSON.stringify(fake.sent), /Claude permission request declined: .* Use local Claude for the blocked action\./);
    assert.match(JSON.stringify(fake.sent), /claude answer/);
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    assert.equal(/sentinel|rm -rf/i.test(JSON.stringify([fake.sent, logged])), false);
    const restarted = await startWithTestStore(directory);
    try {
      const events = listEvents(restarted.database);
      assert.equal(events.filter((event) => event.event_type === "approval_unsupported").length, 1);
      // The pinned scheduler clock keeps the daily cycle from running against the fake CLI.
      assert.equal(events.some((event) => event.event_type.startsWith("memory_review")), false);
      assert.equal(/sentinel|rm -rf/i.test(JSON.stringify(restarted.database.prepare("SELECT * FROM events").all())), false);
      assert.equal(restarted.database.prepare("SELECT agent_provider FROM sessions").get()?.agent_provider, "claude");
    } finally { await restarted.release(); }
  });
});

// A fake `opencode` placed on PATH: it answers --version and each run with two auto-rejected tools, one ordinary tool
// failure, and an answer. Token-shaped literals sit in the tool input, the error text, and stderr.
const fakeOpenCodeScript = `
const argv = process.argv.slice(2);
if (argv[0] === "--version") process.exit(0);
process.stdin.resume();
process.stdin.on("end", () => {
  const sessionID = "ses_wired000000000000000000000";
  const raw = "sk-test-AAAAAAAAAAAAAAAAAAAA ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const rejected = "This non-interactive run cannot ask the user for permission, so the request was rejected. " + raw;
  process.stderr.write("! permission requested: read (opencode-sentinel.env " + raw + "); auto-rejecting\\n");
  process.stderr.write("! permission requested: external_directory (/" + raw + "/*); auto-rejecting\\n");
  for (const event of [
    { type: "step_start", sessionID, part: { type: "step-start" } },
    { type: "tool_use", sessionID, part: { type: "tool", tool: "read", state: { status: "error", input: { path: "opencode-sentinel.env " + raw }, error: rejected } } },
    { type: "tool_use", sessionID, part: { type: "tool", tool: "bash", state: { status: "error", input: { command: "ls /" + raw }, error: rejected } } },
    { type: "tool_use", sessionID, part: { type: "tool", tool: "bash", state: { status: "error", input: { command: "false " + raw }, error: "Command failed " + raw } } },
    { type: "step_finish", sessionID, part: { type: "step-finish", reason: "tool-calls" } },
    { type: "step_start", sessionID, part: { type: "step-start" } },
    { type: "text", sessionID, part: { type: "text", text: "opencode answer" } },
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
});
`;

test("OpenCode startup wires the runtime and notifier, binds the streamed session ID, and keeps tool data out of Discord, logs, and SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-opencode-run-"));
  const bin = join(directory, "bin");
  const previousDirectory = process.cwd();
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  try {
    await mkdir(bin);
    await writeFile(join(bin, "opencode"), `#!${process.execPath}\n${fakeOpenCodeScript}`, { mode: 0o755 });
    process.env.PATH = bin;
    await mkdir(join(directory, "home"));
    process.env.HOME = join(directory, "home");
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv.replace("AGENT_PROVIDER=codex", "AGENT_PROVIDER=opencode"));
    process.chdir(directory);
    const fake = new FakeClient();
    const logged: unknown[] = [];
    console.log = (...args: unknown[]) => { logged.push(args); };
    console.error = (...args: unknown[]) => { logged.push(args); };
    await run([], new DiscordTransport("token", fake as unknown as Client), undefined, beforeReviewTime);
    fake.emit(Events.MessageCreate, {
      guildId: "guild", channelId: "channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
      channel: { isThread: () => false }, reference: null,
      mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
    });
    const sentText = () => JSON.stringify(fake.sent);
    for (let attempt = 0; attempt < 500 && !(sentText().includes("Use local OpenCode for the blocked action") && sentText().includes("opencode answer")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    process.emit("SIGTERM");
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await stat(home.lockFile).then(() => false, () => true)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log = originalLog;
    console.error = originalError;
    assert.match(JSON.stringify(fake.sent), /opencode answer/);
    assert.match(JSON.stringify(logged), /OpenCode cross-session concurrency: unavailable; using global FIFO/);
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    const notice = "OpenCode permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local OpenCode for the blocked action.";
    assert.equal(fake.sent.filter((sent) => JSON.stringify(sent).includes(notice)).length, 1);
    const tokens = ["sk-test-AAAAAAAAAAAAAAAAAAAA", "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"];
    const leaks = (text: string) => tokens.some((token) => text.includes(token)) || /sentinel|permission requested|cannot ask the user|external_directory|Command failed/i.test(text);
    assert.equal(leaks(JSON.stringify([fake.sent, logged])), false);
    const restarted = await startWithTestStore(directory);
    try {
      const session = restarted.database.prepare("SELECT agent_provider, agent_session_id, updated_by FROM sessions").get();
      assert.deepEqual({ ...session }, { agent_provider: "opencode", agent_session_id: "ses_wired000000000000000000000", updated_by: "runtime:opencode" });
      const denied = restarted.database.prepare("SELECT detail, created_by FROM events WHERE event_type = 'approval_unsupported'").all();
      assert.deepEqual(denied.map((row) => ({ ...row })), [{ detail: "declined: no safe action preview; denials=2", created_by: "runtime:opencode" }]);
      assert.equal(restarted.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'agent' AND body = ?").get(notice)?.count, 1);
      assert.equal(restarted.database.prepare("SELECT COUNT(*) AS count FROM approvals").get()?.count, 0);
      const tables = restarted.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const stored = JSON.stringify(tables.map(({ name }) => restarted.database.prepare(`SELECT * FROM "${name}"`).all()));
      assert.equal(leaks(stored), false);
    } finally { await restarted.release(); }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid configuration or database prevents Discord startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-health-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await assert.rejects(start(directory), /Invalid configuration/);
    await writeFile(home.envFile, validEnv);
    await assert.rejects(start(directory), /PostgreSQL operation failed|Agent Instance is already active or not provisioned/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
