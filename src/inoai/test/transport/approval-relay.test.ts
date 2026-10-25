import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ApprovalRelay } from "../../transport/approval-relay.js";
import { CodexAppServer } from "../../connectors/agent-runtime/codex-app-server.js";
import { CodexRuntime } from "../../connectors/agent-runtime/codex-runtime.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { bindAgentSession, createSession, legacyApprovalNotices, openDatabase, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import type { ChatTransport } from "../../connectors/discord/discord.js";
import type { ButtonClick } from "../../transport/ports.js";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  sent: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      while (buffered.includes("\n")) {
        const at = buffered.indexOf("\n");
        const message = JSON.parse(buffered.slice(0, at)) as Record<string, unknown>;
        buffered = buffered.slice(at + 1);
        this.sent.push(message);
        if (message.method === "initialize") this.reply({ id: message.id, result: {} });
        if (message.method === "account/read") this.reply({ id: message.id, result: { account: { type: "chatgpt" } } });
        if (message.method === "thread/start") this.reply({ id: message.id, result: { thread: { id: "thread-1" } } });
        if (message.method === "turn/start") this.reply({ id: message.id, result: { turn: { id: "turn-1" } } });
      }
    });
  }
  reply(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean { this.exitCode = 0; this.emit("exit", 0); return true; }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

class FakeDiscord {
  messages: string[] = [];
  conversations: string[] = [];
  cards: Array<{ conversationId: string; text: string; buttons: Array<{ label: string; customId: string }> }> = [];
  edits: Array<{ conversationId: string; messageId: string; text: string }> = [];
  failCards = false;
  async sendMessage(_conversationId: string, text: string): Promise<string> {
    this.conversations.push(_conversationId);
    this.messages.push(text);
    return `notice-${this.messages.length}`;
  }
  async sendMessageWithButtons(conversationId: string, text: string, buttons: Array<{ label: string; customId: string }>): Promise<string> {
    if (this.failCards) throw new Error("Discord unavailable");
    this.cards.push({ conversationId, text, buttons });
    return `card-${this.cards.length}`;
  }
  async editMessage(conversationId: string, messageId: string, text: string): Promise<void> {
    this.edits.push({ conversationId, messageId, text });
  }
  transport(): ChatTransport { return this as unknown as ChatTransport; }
}

async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (check()) return;
  throw new Error("Condition did not become true");
}

function click(card: FakeDiscord["cards"][number], messageId: string, action: "approve" | "reject", overrides: Partial<ButtonClick> = {}) {
  const replies: string[] = [];
  const updates: string[] = [];
  const input: ButtonClick = {
    customId: card.buttons.find((button) => button.label.toLowerCase() === action)!.customId,
    workspaceId: "guild", conversationId: card.conversationId, messageId, externalUserId: "owner",
    async replyEphemeral(text) { replies.push(text); },
    async updateMessage(text) { updates.push(text); },
    ...overrides,
  };
  return { input, replies, updates };
}

test("Codex command card approves or rejects only its live one-time request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-command-approval-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const store = createSqliteOperationalStore(database);
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const discord = new FakeDiscord();
    let now = Date.now();
    const relay = new ApprovalRelay(store, server, discord.transport(), { workspaceId: "guild", externalUserId: "owner" }, () => now);
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "pending:initial", project_path: directory });
      bindAgentSession(database, session.id, "thread-1");
      const respond = server.respond.bind(server);
      server.respond = (id, result) => {
        if ((result as { decision?: string }).decision === "accept") {
          assert.equal((database.prepare("SELECT state FROM approvals ORDER BY id DESC LIMIT 1").get() as { state: string }).state, "approved");
        }
        if (id === "cmd-response-fail") throw new Error("Codex response unavailable");
        respond(id, result);
      };
      const command = "python3 import_draws.py --csv /tmp/toto.csv";
      const request = (id: string) => ({ id, method: "item/commandExecution/requestApproval", params: {
        kind: "command", threadId: "thread-1", turnId: "turn-1", itemId: id, startedAtMs: now,
        approvalId: null, environmentId: null, reason: null, networkApprovalContext: null,
        command, cwd: directory, commandActions: [{ type: "unknown", command }],
        additionalPermissions: null, proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
        availableDecisions: ["accept", "acceptForSession", "decline"],
      } });
      fake.reply(request("cmd-approve"));
      await until(() => discord.cards.length === 1);
      const card = discord.cards[0]!;
      assert.equal(card.conversationId, "conversation");
      assert(card.text.includes(command) && card.text.includes(directory));
      assert.equal(card.buttons.length, 2);
      for (const bad of [
        { externalUserId: "other" }, { workspaceId: "other" }, { conversationId: "other" }, { messageId: "other" },
      ]) {
        const attempt = click(card, "card-1", "approve", bad);
        await relay.handleClick(attempt.input);
        assert.equal(attempt.replies.length, 1);
        assert.equal(fake.sent.some((entry) => entry.id === "cmd-approve"), false);
      }
      const accepted = click(card, "card-1", "approve");
      await relay.handleClick(accepted.input);
      assert.deepEqual(fake.sent.find((entry) => entry.id === "cmd-approve"), { id: "cmd-approve", result: { decision: "accept" } });
      assert.match(accepted.updates[0]!, /approved/);
      const duplicate = click(card, "card-1", "approve");
      await relay.handleClick(duplicate.input);
      assert.equal(duplicate.replies.length, 1);
      assert.equal(fake.sent.filter((entry) => entry.id === "cmd-approve").length, 1);

      fake.reply(request("cmd-reject"));
      await until(() => discord.cards.length === 2);
      await relay.handleClick(click(discord.cards[1]!, "card-2", "reject").input);
      assert.deepEqual(fake.sent.find((entry) => entry.id === "cmd-reject"), { id: "cmd-reject", result: { decision: "decline" } });

      fake.reply(request("cmd-expired"));
      await until(() => discord.cards.length === 3);
      now += 16 * 60_000;
      await relay.handleClick(click(discord.cards[2]!, "card-3", "approve").input);
      assert.deepEqual(fake.sent.find((entry) => entry.id === "cmd-expired"), { id: "cmd-expired", result: { decision: "decline" } });
      fake.reply(request("cmd-resolved"));
      await until(() => discord.cards.length === 4);
      await until(() => (database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='pending' AND request_message_id IS NOT NULL").get() as { count: number }).count === 1);
      fake.reply({ method: "serverRequest/resolved", params: { requestId: "cmd-resolved" } });
      await until(() => discord.edits.some((edit) => edit.messageId === "card-4"));
      const stale = click(discord.cards[3]!, "card-4", "approve");
      await relay.handleClick(stale.input);
      assert.equal(stale.replies.length, 1);
      assert.equal(fake.sent.some((entry) => entry.id === "cmd-resolved"), false);
      fake.reply(request("cmd-response-fail"));
      await until(() => discord.cards.length === 5);
      await until(() => (database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='pending' AND request_message_id IS NOT NULL").get() as { count: number }).count === 1);
      const uncertain = click(discord.cards[4]!, "card-5", "approve");
      await relay.handleClick(uncertain.input);
      assert.match(uncertain.updates[0]!, /uncertain/);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='approval_response_uncertain'").get() as { count: number }).count, 1);
      assert.equal(fake.sent.some((entry) => entry.id === "cmd-response-fail"), false);
      assert.deepEqual((database.prepare("SELECT state FROM approvals ORDER BY id").all() as Array<{ state: string }>).map((row) => row.state),
        ["approved", "rejected", "expired", "failed", "approved"]);
      const persisted = JSON.stringify({ approvals: database.prepare("SELECT summary FROM approvals").all(), messages: database.prepare("SELECT body FROM messages").all() });
      assert.equal(persisted.includes(command), false);
      assert.equal(persisted.includes(directory), false);
    } finally { relay.close(); await server.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("audit write failure declines instead of accepting a command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-approval-audit-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const store = createSqliteOperationalStore(database);
    const originalResolve = store.resolveCommandApproval!;
    let failure: "throw" | "false" = "throw";
    store.resolveCommandApproval = async (id, state) => {
      if (state === "approved") {
        if (failure === "throw") throw new Error("audit unavailable");
        return false;
      }
      return originalResolve(id, state);
    };
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(store, server, discord.transport(), { workspaceId: "guild", externalUserId: "owner" });
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "pending:initial", project_path: directory });
      bindAgentSession(database, session.id, "thread-1");
      for (const [index, mode] of (["throw", "false"] as const).entries()) {
        failure = mode;
        const id = `audit-${mode}`;
        fake.reply({ id, method: "item/commandExecution/requestApproval", params: {
          kind: "command", threadId: "thread-1", turnId: "turn-1", itemId: id,
          startedAtMs: Date.now(), environmentId: null, command: "python3 import_draws.py --csv /tmp/toto.csv", cwd: directory,
        } });
        await until(() => discord.cards.length === index + 1);
        await until(() => (database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='pending' AND request_message_id IS NOT NULL").get() as { count: number }).count === 1);
        await relay.handleClick(click(discord.cards[index]!, `card-${index + 1}`, "approve").input);
        assert.deepEqual(fake.sent.find((entry) => entry.id === id), { id, result: { decision: "decline" } });
        assert.equal((database.prepare("SELECT state FROM approvals ORDER BY id DESC LIMIT 1").get() as { state: string }).state, "failed");
      }
      assert.equal(fake.sent.some((entry) => (entry.result as { decision?: string } | undefined)?.decision === "accept"), false);
    } finally { relay.close(); await server.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("delivery failure declines and restart fails a pending command card", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-command-recovery-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(createSqliteOperationalStore(database), server, discord.transport(), { workspaceId: "guild", externalUserId: "owner" });
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "pending:initial", project_path: directory });
      bindAgentSession(database, session.id, "thread-1");
      const sendRequest = (id: string) => fake.reply({ id, method: "item/commandExecution/requestApproval", params: {
        kind: "command", threadId: "thread-1", turnId: "turn-1", itemId: id,
        startedAtMs: Date.now(), environmentId: null, command: "python3 import.py", cwd: directory,
      } });
      discord.failCards = true;
      sendRequest("delivery-failure");
      await until(() => fake.sent.some((entry) => entry.id === "delivery-failure"));
      assert.deepEqual(fake.sent.find((entry) => entry.id === "delivery-failure"), { id: "delivery-failure", result: { decision: "decline" } });
      assert.equal((database.prepare("SELECT state FROM approvals ORDER BY id LIMIT 1").get() as { state: string }).state, "failed");

      discord.failCards = false;
      sendRequest("pending-restart");
      await until(() => discord.cards.length === 1);
      await until(() => (database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE state='pending' AND request_message_id IS NOT NULL").get() as { count: number }).count === 1);
      const oldCard = discord.cards[0]!;
      assert.equal(fake.sent.some((entry) => entry.id === "pending-restart"), false);
      relay.close();
      await server.close();
      database.close();

      const reopened = openDatabase(home);
      try {
        const row = reopened.prepare("SELECT state, summary FROM approvals ORDER BY id DESC LIMIT 1").get() as { state: string; summary: string };
        assert.equal(row.state, "failed");
        assert.equal(row.summary, "Codex command approval (preview shown only in Discord)");
        const notices = legacyApprovalNotices(reopened);
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.external_message_id, "card-1");
        assert.equal(notices[0]!.conversation_id, oldCard.conversationId);
        assert.equal((reopened.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='approval_failed_restart'").get() as { count: number }).count, 1);
      } finally { reopened.close(); }
      const stale = click(oldCard, "card-1", "approve");
      await relay.handleClick(stale.input);
      assert.equal(stale.replies.length, 1);
      assert.equal(fake.sent.some((entry) => entry.id === "pending-restart"), false);
    } finally {
      relay.close();
      if (fake.exitCode === null) await server.close();
      if (database.isOpen) database.close();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unsupported Codex approvals fail closed without leaking arbitrary literals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-approval-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const runtime = new CodexRuntime(server);
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(createSqliteOperationalStore(database), server, discord.transport(), { workspaceId: "guild", externalUserId: "owner" });
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "pending:initial", project_path: directory });
      bindAgentSession(database, session.id, await runtime.createSession(directory, "instructions"));
      const iterator = runtime.runTurn("thread-1", "question")[Symbol.asyncIterator]();
      const waiting = iterator.next();
      await until(() => fake.sent.some((entry) => entry.method === "turn/start"));
      const token = "sk-proj-abcdef";
      const credentialUrl = "postgresql://alice:hunter2@db.example.com/toto";
      const userPassword = "alice:hunter2";
      const notices = () => (database.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'agent'").get() as { count: number }).count;
      let expectedNotices = 0;
      const capturedLogs: string[] = [];
      const previousLog = console.log;
      const previousError = console.error;
      console.log = (...parts) => { capturedLogs.push(parts.map(String).join(" ")); };
      console.error = (...parts) => { capturedLogs.push(parts.map(String).join(" ")); };
      try {
        fake.reply({ id: "rpc-attached-user-password", method: "item/commandExecution/requestApproval", params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "attached", command: `tool -u${userPassword}`, cwd: directory,
        } });
        expectedNotices += 1;
        await until(() => fake.sent.some((entry) => entry.id === "rpc-attached-user-password") && notices() === expectedNotices);
      } finally {
        console.log = previousLog;
        console.error = previousError;
      }
      assert.deepEqual(fake.sent.find((entry) => entry.id === "rpc-attached-user-password"),
        { id: "rpc-attached-user-password", result: { decision: "decline" } });
      assert.equal(discord.cards.length, 0);
      assert.equal(capturedLogs.join("\n").includes(userPassword), false);
      assert.equal(JSON.stringify(database.prepare("SELECT summary FROM approvals").all()).includes(userPassword), false);
      assert.equal(JSON.stringify(database.prepare("SELECT body FROM messages").all()).includes(userPassword), false);
      for (const [id, method, detail] of [
        ["rpc-command", "item/commandExecution/requestApproval", { command: `echo ${token}`, cwd: directory }],
        ["rpc-url-userinfo", "item/commandExecution/requestApproval", { command: `psql ${credentialUrl}`, cwd: directory }],
        ["rpc-user-password", "item/commandExecution/requestApproval", { command: `tool -u ${userPassword}`, cwd: directory }],
        ["rpc-file", "item/fileChange/requestApproval", { grantRoot: `${directory}/${token}` }],
        ["rpc-network", "item/commandExecution/requestApproval", { networkApprovalContext: { host: `${token}.example.com`, protocol: "https" } }],
        ["rpc-network-reason", "item/commandExecution/requestApproval", { command: "python3 import.py", cwd: directory, reason: "Need network access" }],
        ["rpc-unknown", "item/commandExecution/requestApproval", {}],
        ["rpc-permission-shape", "item/commandExecution/requestApproval", { command: "python3 import.py", cwd: directory, additionalPermissions: { network: true } }],
        ["rpc-policy-shape", "item/commandExecution/requestApproval", { command: "python3 import.py", cwd: directory, proposedExecpolicyAmendment: { command: "python3" } }],
        ["rpc-stdin", "item/commandExecution/requestApproval", { kind: "writeStdin", command: "python3 import.py", cwd: directory }],
        ["rpc-markdown", "item/commandExecution/requestApproval", { command: "echo ```spoof", cwd: directory }],
        ["rpc-overlong", "item/commandExecution/requestApproval", { command: `echo ${"a".repeat(1900)}`, cwd: directory }],
        ["rpc-other-approval", "item/other/requestApproval", { command: "python3 import.py", cwd: directory }],
      ] as const) {
        fake.reply({ id, method, params: { threadId: "thread-1", turnId: "turn-1", itemId: id, reason: token, ...detail } });
        expectedNotices += 1;
        await until(() => fake.sent.some((entry) => entry.id === id) && notices() === expectedNotices);
        assert.deepEqual(fake.sent.find((entry) => entry.id === id), { id, result: { decision: "decline" } });
      }
      for (const [id, method, params, result] of [
        ["rpc-permissions", "item/permissions/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "permissions", reason: token, permissions: { network: { domains: [token] } } }, { permissions: {}, scope: "turn" }],
        ["rpc-patch", "applyPatchApproval", { conversationId: "thread-1", callId: "patch", grantRoot: token, reason: token }, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }],
        ["rpc-exec", "execCommandApproval", { conversationId: "thread-1", callId: "exec", command: ["echo", token], reason: token }, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }],
      ] as const) {
        fake.reply({ id, method, params });
        expectedNotices += 1;
        await until(() => fake.sent.some((entry) => entry.id === id) && notices() === expectedNotices);
        assert.deepEqual(fake.sent.find((entry) => entry.id === id), { id, result });
      }
      assert.equal(discord.messages.length, expectedNotices);
      assert.equal(discord.cards.length, 0);
      assert(discord.messages.every((message) => message === discord.messages[0] && /declined.*safe.*preview.*local Codex/.test(message)));
      assert(discord.conversations.every((conversation) => conversation === "conversation"));
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count, 0);
      const persisted = JSON.stringify({
        messages: database.prepare("SELECT body FROM messages").all(),
        events: database.prepare("SELECT event_type, detail FROM events").all(),
      });
      assert.equal(persisted.includes(token), false);
      assert.equal(persisted.includes(credentialUrl), false);
      assert.equal(persisted.includes(userPassword), false);
      assert.equal(JSON.stringify(discord).includes(token), false);
      assert.equal(JSON.stringify(discord).includes(userPassword), false);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'approval_unsupported'").get() as { count: number }).count, expectedNotices);
      fake.reply({ id: "unrelated", method: "item/tool/requestUserInput", params: { threadId: "thread-1" } });
      await tick();
      assert.equal(fake.sent.some((entry) => entry.id === "unrelated"), false);
      fake.reply({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      assert.equal((await waiting).value?.type, "answer");
      await iterator.next();
    } finally { relay.close(); await server.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("approval requests for a Codex review thread are declined without touching SQLite Sessions or Discord", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-approval-review-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const runtime = new CodexRuntime(server, undefined, undefined, true);
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(createSqliteOperationalStore(database), server, discord.transport(), { workspaceId: "guild", externalUserId: "owner" });
    try {
      const counts = () => JSON.stringify(["sessions", "messages", "events", "approvals"].map((table) =>
        (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
      const before = counts();
      const review = runtime.review!("review prompt");
      await until(() => fake.sent.some((entry) => entry.method === "turn/start"));
      await tick();
      fake.reply({ id: "rpc-review", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "c", command: "touch pwned.txt" } });
      await until(() => fake.sent.some((entry) => entry.id === "rpc-review"));
      assert.deepEqual(fake.sent.find((entry) => entry.id === "rpc-review"), { id: "rpc-review", result: { decision: "decline" } });
      fake.reply({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "{}" } } });
      fake.reply({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      assert.equal(await review, "{}");
      assert.equal(counts(), before);
      assert.deepEqual(discord.messages, []);
    } finally { relay.close(); await server.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
