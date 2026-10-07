import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "../test/sqlite-store.js";

import type { AgentRuntime } from "../agent-runtime.js";
import { ConversationWorker } from "./conversation-worker.js";
import { archiveMessage, createMemory, createSession, listMessages, openDatabase, softDeleteMemory, upsertUser } from "../database.js";
import { composeTurnPrompt } from "./prompt-context.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

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
