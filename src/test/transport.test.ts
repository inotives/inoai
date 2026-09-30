import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, Events } from "discord.js";
import type { Client } from "discord.js";

import { createChatTransport, DiscordTransport } from "../transport.js";
import type { IncomingMessage } from "../transport.js";
import { archiveMessage, claimLegacyApprovalNotice, createSession, legacyApprovalNotices, listEvents, listMessages } from "../database.js";
import { run, start, startTransport } from "../index.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

class FakeClient extends EventEmitter {
  user = { id: "inoai" };
  destroyed = false;
  failSend = false;
  sendStarted?: () => void;
  sendGate?: Promise<void>;
  sent: unknown[] = [];
  threadCount = 0;
  deletedThreads: string[] = [];
  editedApprovals: string[] = [];
  threadStarted?: () => void;
  threadGate?: Promise<void>;
  channels = { fetch: async (id: string) => id === "parent" || id === "channel" ? {
    type: ChannelType.GuildText,
    guildId: "guild",
    threads: { create: async (options: unknown) => { this.threadStarted?.(); await this.threadGate; this.sent.push(options); return { id: ++this.threadCount === 1 ? "thread" : `thread-${this.threadCount}` }; } },
    send: async (options: unknown) => { this.sendStarted?.(); await this.sendGate; if (this.failSend) throw new Error("send failed"); this.sent.push(options); return { id: `sent-${this.sent.length}` }; },
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
    { content: "answer", reply: { messageReference: "previous" } },
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
  "DISCORD_ALLOWED_CHANNEL_ID=channel",
  "CHAT_PROVIDER=discord",
  "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00",
  "MEMORY_REVIEW_MAX_CHARS=20000",
].join("\n");

test("plain reply pings are ignored while explicit top-level mentions create distinct threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-conversation-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const instance = await start(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client));
      const incoming = (id: string) => ({
        guildId: "guild", channelId: "channel", id, author: { id: "owner", bot: false }, content: `<@inoai> ${id}`,
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
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
      fake.emit(Events.MessageCreate, incoming("first"));
      fake.emit(Events.MessageCreate, incoming("first"));
      await new Promise((resolve) => setImmediate(resolve));
      fake.emit(Events.MessageCreate, incoming("first"));
      fake.emit(Events.MessageCreate, incoming("second"));
      await new Promise((resolve) => setImmediate(resolve));

      const sessions = instance.database.prepare("SELECT * FROM sessions ORDER BY id").all() as Array<{ id: number; conversation_id: string; initiating_external_message_id: string; project_path: string }>;
      assert.deepEqual(sessions.map(({ conversation_id, initiating_external_message_id }) => [conversation_id, initiating_external_message_id]), [
        ["thread", "first"], ["thread-2", "second"],
      ]);
      assert(sessions.every((session) => session.project_path === directory));
      for (const session of sessions) {
        const messages = listMessages(instance.database, session.id);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.external_message_id, session.initiating_external_message_id);
        assert.equal(messages[0]?.body, `<@inoai> ${session.initiating_external_message_id}`);
        assert.equal(messages[0]?.state, "pending");
      }
      assert.equal(fake.threadCount, 2);
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
    const instance = await start(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client));
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
    const instance = await start(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client));
      const incoming = {
        guildId: "guild", channelId: "channel", id: "request", author: { id: "owner", bot: false }, content: "<@inoai> task",
        channel: { isThread: () => false }, reference: null,
        mentions: { parsedUsers: new Map([["inoai", { id: "inoai", bot: true }]]) },
      };
      instance.database.exec("CREATE TEMP TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'session failed'); END");
      fake.emit(Events.MessageCreate, incoming);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(instance.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
      assert.deepEqual(fake.deletedThreads, ["thread"]);
      instance.database.exec("DROP TRIGGER fail_session");
      fake.emit(Events.MessageCreate, incoming);
      await new Promise((resolve) => setImmediate(resolve));
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
    await run([], new DiscordTransport("token", fake as unknown as Client));
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
    const restarted = await start(directory);
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
    const instance = await start(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(instance, undefined, new DiscordTransport("token", fake as unknown as Client));
      assert.deepEqual(fake.sent, [{ content: "inoai is online" }]);
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

test("legacy approval recovery fails closed once, removes old controls, and keeps the Session usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-legacy-approval-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, validEnv);
    const first = await start(directory);
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

    const recovered = await start(directory);
    try {
      const approval = recovered.database.prepare("SELECT state, summary, resolution_message_id FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get();
      assert.equal(approval?.state, "failed");
      assert.equal(approval?.summary, "Legacy approval request redacted");
      assert.equal(recovered.database.prepare("SELECT summary FROM approvals WHERE runtime_approval_id = 'previously-failed'").get()?.summary, "Legacy approval request redacted");
      assert.equal(listMessages(recovered.database, session.id).find((message) => message.id === request.message!.id)?.body, "Legacy approval request redacted");
      assert.equal(listMessages(recovered.database, session.id).find((message) => message.external_message_id === "ordinary-user")?.body, "ordinary user request");
      assert.equal(listEvents(recovered.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      const fake = new FakeClient();
      const transport = await startTransport(recovered, undefined, new DiscordTransport("token", fake as unknown as Client));
      assert.deepEqual(fake.editedApprovals, ["old-control"]);
      assert.deepEqual(fake.sent[0], { content: "A saved Codex approval could not be resumed after restart. No action was approved.", components: [] });
      assert(fake.sent.some((message) => JSON.stringify(message).includes("Please make a fresh request")));
      assert(!JSON.stringify(fake.sent).includes("secret-123"));
      assert.equal(typeof recovered.database.prepare("SELECT resolution_message_id FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get()?.resolution_message_id, "number");
      assert.equal(listMessages(recovered.database, session.id).filter((message) => message.body.includes("Please make a fresh request")).length, 1);
      assert.equal(fake.listenerCount(Events.InteractionCreate), 0);
      fake.emit(Events.InteractionCreate, { customId: "approve:lost-json-rpc" });
      assert.equal(recovered.database.prepare("SELECT state FROM approvals WHERE runtime_approval_id = 'lost-json-rpc'").get()?.state, "failed");
      await transport.stop();
    } finally {
      await recovered.release();
    }

    const again = await start(directory);
    try {
      const fake = new FakeClient();
      const transport = await startTransport(again, undefined, new DiscordTransport("token", fake as unknown as Client));
      assert.deepEqual(fake.sent, [{ content: "inoai is online" }]);
      assert.equal(listEvents(again.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      assert.equal(again.database.prepare("SELECT state FROM sessions WHERE id = ?").get(session.id)?.state, "active");
      fake.emit(Events.MessageCreate, {
        guildId: "guild", channelId: "thread", id: "fresh-request", author: { id: "owner", bot: false }, content: "fresh request",
        channel: { isThread: () => true, parentId: "channel" }, reference: null, mentions: { parsedUsers: new Map() },
      });
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
    const first = await start(directory);
    const session = createSession(first.database, {
      user_id: first.owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
      conversation_id: "thread", initiating_external_message_id: "initial", agent_provider: "codex",
      agent_session_id: "legacy-thread", project_path: directory,
    });
    first.database.prepare(`INSERT INTO approvals (session_id, runtime_approval_id, summary, expires_at)
      VALUES (?, 'lost-request', 'unsafe preview', unixepoch() + 3600)`).run(session.id);
    await first.release();

    const recovered = await start(directory);
    assert.equal(legacyApprovalNotices(recovered.database).length, 1);
    assert.equal(claimLegacyApprovalNotice(recovered.database, legacyApprovalNotices(recovered.database)[0]!.id), true);
    await recovered.release(); // Crash boundary: the claim committed, but Discord send never happened.

    const again = await start(directory);
    try {
      assert.equal(legacyApprovalNotices(again.database).length, 0);
      assert.equal(listEvents(again.database, session.id).filter((event) => event.event_type === "legacy_approval_failed").length, 1);
      const fake = new FakeClient();
      const transport = await startTransport(again, undefined, new DiscordTransport("token", fake as unknown as Client));
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
    const instance = await start(directory);
    try {
      class LoginFailure extends FakeClient {
        override async login(): Promise<string> { throw new Error("login failed"); }
      }
      const disconnected = new LoginFailure();
      await assert.rejects(startTransport(instance, undefined, new DiscordTransport("token", disconnected as unknown as Client)), /login failed/);
      assert.equal(disconnected.sent.length, 0);

      const failed = new FakeClient();
      failed.failSend = true;
      await assert.rejects(startTransport(instance, undefined, new DiscordTransport("token", failed as unknown as Client)), /send failed/);
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
    const instance = await start(directory);
    try {
      const fake = new FakeClient();
      let sendStarted!: () => void;
      let finishSend!: () => void;
      const sending = new Promise<void>((resolve) => { sendStarted = resolve; });
      fake.sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
      fake.sendStarted = sendStarted;
      const transport = new DiscordTransport("token", fake as unknown as Client);
      const starting = startTransport(instance, undefined, transport);
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
    const running = run([], new DiscordTransport("token", fake as unknown as Client));
    await sending;
    process.emit("SIGTERM");
    finishSend();
    await running;
    const restarted = await start(directory);
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
    await run([], new DiscordTransport("token", fake as unknown as Client));
    fake.emit(Events.ShardDisconnect);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await stat(home.lockFile).then(() => false, () => true)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
    assert.equal(process.exitCode, 1);
    const restarted = await start(directory);
    await restarted.release();
  } finally {
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
    await rm(home.databaseFile);
    await mkdir(home.databaseFile);
    await assert.rejects(start(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
