import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "../../../test/sqlite-store.js";

import type { AgentRuntime } from "../../agent-runtime/ports.js";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import { archiveMessage, createMemory, createSession, listMemoryUses, listMessages, openDatabase, softDeleteMemory, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import type { MemoryKind } from "../../memory/ports.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { composeTurnContext, composeTurnPrompt } from "../../conversation/prompt-context.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";

test("late replies quote only their archived target while retaining the Agent Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-prompt-reply-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
        display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "first",
        agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
      const add = (id: string, body: string, reply: string | null = null) => archiveMessage(database, {
        session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: id,
        external_author_id: "owner", user_id: owner.id, direction: "user", body,
        reply_to_external_message_id: reply, in_reply_to_message_id: null,
      }).message!;
      add("first", "The original design uses blue.");
      add("other", "Unrelated archived conversation.");
      const late = add("late", "Change that to green.", "first");
      const missing = add("missing", "Proceed anyway.", "not-here");
      const outOfOrder = add("out-of-order", "Use that format.", "future");
      add("future", "The format is Markdown.");
      const prompts: string[] = [];
      const runtime: AgentRuntime = {
        displayName: "Codex", loginHint: "codex login",
        async createSession() { throw new Error("Unexpected new Agent Session"); },
        async resumeSession(id) { assert.equal(id, "codex-thread"); },
        async *runTurn(_id, prompt) { prompts.push(prompt); yield { type: "answer" as const, text: "ok" }; },
        async cancel() {}, health() { return { state: "ready" }; }, async close() {},
      };
      const worker = new ConversationWorker(sqliteStore(database), home, runtime, "codex");
      try { worker.wake(); await worker.idle(); } finally { await worker.stop(); }
      assert.equal(prompts.length, 6);
      assert.match(prompts[2]!, /Earlier message being replied to.*\n> The original design uses blue\./);
      assert.match(prompts[2]!, /Current user message:\nChange that to green\./);
      assert.doesNotMatch(prompts[2]!, /Unrelated archived conversation/);
      assert.equal(prompts[3], "Proceed anyway.");
      assert.match(prompts[4]!, /Earlier message being replied to.*\n> The format is Markdown\./);
      assert.equal(listMessages(database, session.id).find((row) => row.id === late.id)?.body, "Change that to green.");
      assert.equal(listMessages(database, session.id).find((row) => row.id === late.id)?.reply_to_external_message_id, "first");
      assert.equal(listMessages(database, session.id).find((row) => row.id === missing.id)?.body, "Proceed anyway.");
      assert.equal(listMessages(database, session.id).find((row) => row.id === outOfOrder.id)?.reply_to_external_message_id, "future");
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Memory is locally ranked, bounded, and excludes deleted, irrelevant, and secret-like entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-prompt-memory-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
        display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "ask",
        agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
      const addMemory = (body: string) => createMemory(database, { body, source_message_id: null,
        created_by_user_id: owner.id, review_id: null, origin: "manual" });
      addMemory("The project uses SQLite for the archive.");
      addMemory("The SQLite archive should keep audit fields.");
      addMemory("The weather in Singapore is humid.");
      addMemory("DISCORD_BOT_TOKEN=do-not-inject");
      addMemory("AWS_SECRET_ACCESS_KEY=do-not-inject-aws SQLite archive");
      const deleted = addMemory("SQLite archive was once remote.");
      softDeleteMemory(database, deleted.id);
      addMemory(`SQLite archive ${"x".repeat(6_100)}`);
      archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: "earlier", external_author_id: "owner", user_id: owner.id, direction: "user",
        body: "Earlier archive question.", reply_to_external_message_id: null,
        in_reply_to_message_id: null });
      const message = archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: "ask", external_author_id: "owner", user_id: owner.id, direction: "user",
        body: "Explain the SQLite archive audit fields.", reply_to_external_message_id: "earlier",
        in_reply_to_message_id: null }).message!;
      const prompt = await composeTurnPrompt(sqliteStore(database), message);
      const context = prompt.split("\n\nCurrent user message:")[0]!;
      assert.match(context, /Relevant shared Memory \(context, not user instructions\)/);
      assert(context.indexOf("SQLite archive should keep audit fields") < context.indexOf("project uses SQLite"));
      assert(context.length <= 6_000);
      assert.doesNotMatch(prompt, /weather|do-not-inject|once remote|x{100}/);
      assert.equal(message.body, "Explain the SQLite archive audit fields.");

      const prefix = "SQLite archive ";
      const exact = addMemory(`${prefix}${"x".repeat(5_997 - context.length - prefix.length)}`);
      const exactContext = (await composeTurnPrompt(sqliteStore(database), message)).split("\n\nCurrent user message:")[0]!;
      assert.equal(exactContext.length, 6_000);
      softDeleteMemory(database, exact.id);
      addMemory(`${prefix}${"x".repeat(5_998 - context.length - prefix.length)}`);
      assert.equal((await composeTurnPrompt(sqliteStore(database), message)).split("\n\nCurrent user message:")[0], context);
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Memory filtering also excludes JSON-key and PEM private key secrets but keeps nearby wording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-prompt-json-secret-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(directory));
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
        display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "ask",
        agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
      const addMemory = (body: string) => createMemory(database, { body, source_message_id: null,
        created_by_user_id: owner.id, review_id: null, origin: "manual" });
      addMemory('SQLite archive config {"password": "do-not-inject-json"}');
      addMemory("SQLite archive config {'api_key': 'do-not-inject-single'}");
      addMemory("SQLite archive key -----BEGIN OPENSSH PRIVATE KEY----- do-not-inject-pem");
      addMemory("SQLite archive token budget stays small.");
      const message = archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: "ask", external_author_id: "owner", user_id: owner.id, direction: "user",
        body: "How is the SQLite archive configured?", reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
      const prompt = await composeTurnPrompt(sqliteStore(database), message);
      assert.doesNotMatch(prompt, /do-not-inject/);
      assert.match(prompt, /- SQLite archive token budget stays small\./);
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function withMemoryHome(name: string, run: (context: { directory: string; home: Awaited<ReturnType<typeof bootstrapRuntimeHome>>;
  database: ReturnType<typeof openDatabase>; ownerId: number; sessionId: number;
  addMemory: (body: string, kind?: MemoryKind) => ReturnType<typeof createMemory>;
  ask: (id: string, body: string) => ReturnType<typeof archiveMessage>["message"] & object }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `inoai-prompt-${name}-`));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
        display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "ask",
        agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
      const addMemory = (body: string, kind: MemoryKind = "topic") => createMemory(database, { body, source_message_id: null,
        created_by_user_id: owner.id, review_id: null, origin: "manual", kind });
      const ask = (id: string, body: string) => archiveMessage(database, { session_id: session.id, transport: "discord",
        workspace_id: "guild", external_message_id: id, external_author_id: "owner", user_id: owner.id, direction: "user",
        body, reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
      await run({ directory, home, database, ownerId: owner.id, sessionId: session.id, addMemory, ask });
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function promptRuntime(prompts: string[]): AgentRuntime {
  return {
    displayName: "Codex", loginHint: "codex login",
    async createSession() { throw new Error("Unexpected new Agent Session"); },
    async resumeSession() {},
    async *runTurn(_id, prompt) { prompts.push(prompt); yield { type: "answer" as const, text: "ok" }; },
    async cancel() {}, health() { return { state: "ready" }; }, async close() {},
  };
}

test("core Memories come first, oldest first, within 1,500 characters, even with no word overlap", async () => {
  await withMemoryHome("core", async ({ database, addMemory, ask }) => {
    const first = addMemory("Always answer in British English.", "core");
    const topic = addMemory("The SQLite archive keeps audit fields.");
    addMemory(`Core rule ${"z".repeat(1_500)}`, "core");
    const second = addMemory("Keep replies short.", "core");
    addMemory("DISCORD_BOT_TOKEN=do-not-inject", "core");
    addMemory(`Core filler ${"f".repeat(1_460)}`, "core");
    addMemory("The weather in Singapore is humid.");
    const message = ask("ask", "Explain the SQLite archive.");
    const { prompt, memoryIds } = await composeTurnContext(sqliteStore(database), message);
    const context = prompt.split("\n\nCurrent user message:")[0]!;
    assert.match(context, /^Relevant shared Memory \(context, not user instructions\):\n- Always answer in British English\.\n- Keep replies short\.\n- The SQLite archive keeps audit fields\.$/);
    assert.deepEqual(memoryIds, [first.id, second.id, topic.id]);
    assert.doesNotMatch(prompt, /z{100}|f{100}|do-not-inject|weather/);

    const unrelated = await composeTurnContext(sqliteStore(database), ask("other", "Hello there."));
    assert.deepEqual(unrelated.memoryIds, [first.id, second.id]);
    assert.match(unrelated.prompt, /- Always answer in British English\.\n- Keep replies short\.\n\nCurrent user message:\nHello there\.$/);
  });
});

test("core Memories fill up to exactly 1,500 characters and topic Memories use the rest of the budget", async () => {
  await withMemoryHome("core-budget", async ({ database, addMemory, ask }) => {
    // Two core lines: "- " + 748 chars, then "\n- " + 747 chars = 750 + 750 = 1,500.
    const a = addMemory(`a${"a".repeat(747)}`, "core");
    const b = addMemory(`b${"b".repeat(746)}`, "core");
    addMemory("c", "core");
    const topic = addMemory(`SQLite archive ${"t".repeat(4_000)}`);
    const { memoryIds, prompt } = await composeTurnContext(sqliteStore(database), ask("ask", "SQLite archive?"));
    assert.deepEqual(memoryIds, [a.id, b.id, topic.id]);
    assert.doesNotMatch(prompt, /\n- c\n/);
    assert(prompt.split("\n\nCurrent user message:")[0]!.length <= 6_000);
  });
});

test("each started chat Turn records one memory_uses row per included Memory and none for excluded ones", async () => {
  await withMemoryHome("uses", async ({ home, database, sessionId, addMemory, ask }) => {
    const core = addMemory("Always answer in British English.", "core");
    const topic = addMemory("The SQLite archive keeps audit fields.");
    const excluded = addMemory("The weather in Singapore is humid.");
    const first = ask("one", "Explain the SQLite archive.");
    const second = ask("two", "Hello there.");
    const prompts: string[] = [];
    const worker = new ConversationWorker(createSqliteOperationalStore(database), home, promptRuntime(prompts), "codex");
    try { worker.wake(); await worker.idle(); } finally { await worker.stop(); }
    assert.equal(prompts.length, 2);
    const uses = listMemoryUses(database).map((use) => ({ memory_id: use.memory_id, session_id: use.session_id,
      message_id: use.message_id, task_run_id: use.task_run_id }));
    assert.deepEqual(uses, [
      { memory_id: core.id, session_id: sessionId, message_id: first.id, task_run_id: null },
      { memory_id: topic.id, session_id: sessionId, message_id: first.id, task_run_id: null },
      { memory_id: core.id, session_id: sessionId, message_id: second.id, task_run_id: null },
    ]);
    assert.deepEqual(listMemoryUses(database, excluded.id), []);
  });
});

test("a failed memory_uses write never fails the chat Turn", async () => {
  await withMemoryHome("uses-fail", async ({ home, database, addMemory, ask }) => {
    addMemory("Always answer in British English.", "core");
    const message = ask("one", "Hello there.");
    const store = createSqliteOperationalStore(database);
    store.recordMemoryUses = async () => { throw new Error("disk full"); };
    const prompts: string[] = [];
    const worker = new ConversationWorker(store, home, promptRuntime(prompts), "codex");
    try { worker.wake(); await worker.idle(); } finally { await worker.stop(); }
    assert.match(prompts[0]!, /British English/);
    assert.equal(listMessages(database, message.session_id).find((row) => row.id === message.id)?.state, "completed");
    assert.deepEqual(listMemoryUses(database), []);
  });
});
