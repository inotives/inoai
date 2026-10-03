import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ApprovalRelay } from "../approval-relay.js";
import { CodexAppServer } from "../codex-app-server.js";
import { CodexRuntime } from "../codex-runtime.js";
import { bindAgentSession, createSession, openDatabase, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { ChatTransport } from "../transport.js";

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
  async sendMessage(_conversationId: string, text: string): Promise<string> {
    this.conversations.push(_conversationId);
    this.messages.push(text);
    return `notice-${this.messages.length}`;
  }
  transport(): ChatTransport { return this as unknown as ChatTransport; }
}

async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("unsupported Codex approvals fail closed without leaking arbitrary literals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-approval-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const fake = new FakeProcess();
    const server = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
    const runtime = new CodexRuntime(server);
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(database, server, discord.transport());
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "pending:initial", project_path: directory });
      bindAgentSession(database, session.id, await runtime.createSession(directory, "instructions"));
      const iterator = runtime.runTurn("thread-1", "question")[Symbol.asyncIterator]();
      const waiting = iterator.next();
      await tick();
      const token = "sk-proj-abcdef";
      for (const [id, method, detail] of [
        ["rpc-command", "item/commandExecution/requestApproval", { command: `echo ${token}`, cwd: directory }],
        ["rpc-file", "item/fileChange/requestApproval", { grantRoot: `${directory}/${token}` }],
        ["rpc-network", "item/commandExecution/requestApproval", { networkApprovalContext: { host: `${token}.example.com`, protocol: "https" } }],
        ["rpc-unknown", "item/commandExecution/requestApproval", {}],
      ] as const) {
        fake.reply({ id, method, params: { threadId: "thread-1", turnId: "turn-1", itemId: id, ...detail, reason: token } });
        await tick();
        assert.deepEqual(fake.sent.find((entry) => entry.id === id), { id, result: { decision: "decline" } });
      }
      for (const [id, method, params, result] of [
        ["rpc-permissions", "item/permissions/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "permissions", reason: token, permissions: { network: { domains: [token] } } }, { permissions: {}, scope: "turn" }],
        ["rpc-patch", "applyPatchApproval", { conversationId: "thread-1", callId: "patch", grantRoot: token, reason: token }, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }],
        ["rpc-exec", "execCommandApproval", { conversationId: "thread-1", callId: "exec", command: ["echo", token], reason: token }, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }],
      ] as const) {
        fake.reply({ id, method, params });
        await tick();
        assert.deepEqual(fake.sent.find((entry) => entry.id === id), { id, result });
      }
      assert.equal(discord.messages.length, 7);
      assert(discord.messages.every((message) => message === discord.messages[0] && /declined.*safe.*preview.*local Codex/.test(message)));
      assert(discord.conversations.every((conversation) => conversation === "conversation"));
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count, 0);
      const persisted = JSON.stringify({
        messages: database.prepare("SELECT body FROM messages").all(),
        events: database.prepare("SELECT event_type, detail FROM events").all(),
      });
      assert.equal(persisted.includes(token), false);
      assert.equal(JSON.stringify(discord).includes(token), false);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'approval_unsupported'").get() as { count: number }).count, 7);
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
    const relay = new ApprovalRelay(database, server, discord.transport());
    try {
      const counts = () => JSON.stringify(["sessions", "messages", "events", "approvals"].map((table) =>
        (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
      const before = counts();
      const review = runtime.review!("review prompt");
      while (!fake.sent.some((entry) => entry.method === "turn/start")) await tick();
      await tick();
      fake.reply({ id: "rpc-review", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "c", command: "touch pwned.txt" } });
      await tick();
      assert.deepEqual(fake.sent.find((entry) => entry.id === "rpc-review"), { id: "rpc-review", result: { decision: "decline" } });
      fake.reply({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "{}" } } });
      fake.reply({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      assert.equal(await review, "{}");
      assert.equal(counts(), before);
      assert.deepEqual(discord.messages, []);
    } finally { relay.close(); await server.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rebinds approval handling to a replacement app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-approval-rebind-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    const firstProcess = new FakeProcess();
    const first = await CodexAppServer.connect({ spawnProcess: () => firstProcess.child() });
    const secondProcess = new FakeProcess();
    const second = await CodexAppServer.connect({ spawnProcess: () => secondProcess.child() });
    const discord = new FakeDiscord();
    const relay = new ApprovalRelay(database, first, discord.transport());
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "conversation", initiating_external_message_id: "initial", agent_provider: "codex", agent_session_id: "thread-1", project_path: directory });
      relay.bind(second);
      secondProcess.reply({ id: "replacement-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "echo safe" } });
      await tick();
      assert.deepEqual(secondProcess.sent.find((entry) => entry.id === "replacement-approval"), { id: "replacement-approval", result: { decision: "decline" } });
      assert.equal(firstProcess.sent.some((entry) => entry.id === "replacement-approval"), false);
      assert.equal(discord.messages.length, 1);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'approval_unsupported'").get() as { count: number }).count, 1);
      assert.equal(session.id > 0, true);
    } finally { relay.close(); await first.close(); await second.close(); database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
