import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startAgentSession } from "../application/conversation/agent-session.js";
import { classifyIncomingMessage } from "../application/conversation/inbound-policy.js";
import { manageMemoryWithStore } from "../application/memory/memory-operations.js";

test("conversation application policy uses its owned store port", async () => {
  const user = { id: 7 };
  const message = {
    transport: "discord",
    workspaceId: "guild",
    conversationId: "channel",
    parentConversationId: null,
    externalUserId: "owner",
    mentionedBotUserIds: ["bot"],
    botUserId: "bot",
    authorIsBot: false,
  };
  const store = {
    findUser: async () => user,
    findSessionByConversation: async () => undefined,
  };

  assert.deepEqual(await classifyIncomingMessage(store, {
    chatProvider: "discord",
    discordGuildId: "guild",
    discordStatusChannelId: "status",
  }, message), { kind: "top-level", user });
});

test("conversation session use case uses runtime and persistence ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-application-"));
  const agentFile = join(directory, "agent.md");
  await writeFile(agentFile, "instructions", "utf8");
  try {
    const calls: string[] = [];
    const database = {
      async getSession() { return { agent_session_id: "pending:message", project_path: "/project", agent_provider: "codex", state: "active" }; },
      async bindAgentSession(_sessionId: number, agentSessionId: string, actor: string) { calls.push(`${agentSessionId}:${actor}`); },
    };
    const runtime = { async createSession(project: string, instructions: string) { calls.push(`${project}:${instructions}`); return "runtime-session"; } };
    assert.equal(await startAgentSession(database, runtime, 1, { agentFile }), "runtime-session");
    assert.deepEqual(calls, ["/project:instructions", "runtime-session:runtime:codex"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory application use case remains store-only", async () => {
  const memories: Array<{ id: number; body: string; created_at: number; created_by: string; updated_at: number; updated_by: string; deleted_at: null; deleted_by: null; source_message_id: null; created_by_user_id: number; review_id: null; origin: "manual"; state: "active" }> = [];
  const store = {
    async listMemories() { return memories; },
    async createMemory(input: { body: string; created_by_user_id: number | null }) {
      const memory = { id: 1, body: input.body, created_at: 0, created_by: "test", updated_at: 0, updated_by: "test", deleted_at: null, deleted_by: null, source_message_id: null, created_by_user_id: input.created_by_user_id ?? 0, review_id: null, origin: "manual" as const, state: "active" as const };
      memories.push(memory);
      return memory;
    },
    async softDeleteMemory(id: number) { memories.splice(memories.findIndex((memory) => memory.id === id), 1); },
  };
  assert.equal((await manageMemoryWithStore(store, "add", "  durable fact  ", 7) as { body: string }).body, "durable fact");
  assert.equal((await manageMemoryWithStore(store, "list", undefined, 7) as Array<{ body: string }>)[0]?.body, "durable fact");
  await manageMemoryWithStore(store, "delete", "1", 7);
  assert.deepEqual(memories, []);
});
