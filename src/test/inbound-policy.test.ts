import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateConfiguration } from "../config.js";
import { bootstrapOwner, createSession, openDatabase, upsertUser } from "../database.js";
import { classifyIncomingMessage } from "../inbound-policy.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { IncomingMessage } from "../transport.js";

test("inbound policy admits only the active owner in the configured Discord location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-eligibility-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(directory));
    try {
      const configuration = validateConfiguration({
        DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "guild", DISCORD_OWNER_USER_ID: "owner", DISCORD_ALLOWED_CHANNEL_ID: "channel",
        CHAT_PROVIDER: "discord", AGENT_PROVIDER: "codex", MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
      });
      const owner = bootstrapOwner(database, configuration);
      const topLevel: IncomingMessage = {
        transport: "discord", workspaceId: "guild", conversationId: "channel", parentConversationId: null,
        externalMessageId: "message", externalUserId: "owner", body: "<@inoai> work", replyToExternalMessageId: null,
        mentionedUserIds: ["inoai"], mentionedBotUserIds: ["inoai"], botUserId: "inoai", authorIsBot: false,
      };
      assert.deepEqual(classifyIncomingMessage(database, configuration, topLevel), { kind: "top-level", user: owner });

      for (const change of [
        { authorIsBot: true }, { workspaceId: "other-guild" }, { conversationId: "other-channel" },
        { externalUserId: "stranger" }, { botUserId: null },
        { mentionedBotUserIds: [] }, { mentionedBotUserIds: ["other-bot"] },
        { mentionedBotUserIds: ["inoai", "other-bot"] },
      ]) assert.equal(classifyIncomingMessage(database, configuration, { ...topLevel, ...change }), null);

      const session = createSession(database, {
        user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
        conversation_id: "owned-thread", initiating_external_message_id: "message", agent_provider: "codex",
        agent_session_id: "pending:message", project_path: directory,
      });
      const thread = { ...topLevel, conversationId: "owned-thread", parentConversationId: "channel", mentionedUserIds: [], mentionedBotUserIds: [] };
      assert.deepEqual(classifyIncomingMessage(database, configuration, thread), { kind: "bound-thread", user: owner, session });
      assert.equal(classifyIncomingMessage(database, configuration, { ...thread, conversationId: "other-bot-thread" }), null);
      assert.equal(classifyIncomingMessage(database, configuration, { ...thread, parentConversationId: "other-channel" }), null);
      assert.equal(classifyIncomingMessage(database, configuration, { ...thread, externalUserId: "stranger" }), null);
      assert.equal(classifyIncomingMessage(database, configuration, { ...thread, authorIsBot: true }), null);

      upsertUser(database, {
        transport: "discord", workspace_id: "guild", external_user_id: "family", display_name: null,
        role: "family", state: "active",
      });
      assert.equal(classifyIncomingMessage(database, configuration, { ...topLevel, externalUserId: "family" }), null);
      assert.equal(classifyIncomingMessage(database, configuration, { ...thread, externalUserId: "family" }), null);

      upsertUser(database, {
        transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null,
        role: "family", state: "active",
      });
      assert.equal(classifyIncomingMessage(database, configuration, topLevel), null);
      assert.equal(classifyIncomingMessage(database, configuration, thread), null);
      bootstrapOwner(database, configuration);

      database.prepare("UPDATE users SET state = 'disabled' WHERE id = ?").run(owner.id);
      assert.equal(classifyIncomingMessage(database, configuration, topLevel), null);
      assert.equal(classifyIncomingMessage(database, configuration, thread), null);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
