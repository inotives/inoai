import type { DatabaseSync } from "node:sqlite";

import type { Configuration } from "./config.js";
import type { SessionRecord, UserRecord } from "./database.js";
import type { IncomingMessage } from "./transport.js";

export type EligibleIncomingMessage =
  | { kind: "top-level"; user: UserRecord }
  | { kind: "bound-thread"; user: UserRecord; session: SessionRecord };

export function classifyIncomingMessage(
  database: DatabaseSync,
  configuration: Configuration,
  message: IncomingMessage,
): EligibleIncomingMessage | null {
  if (message.authorIsBot || message.transport !== configuration.chatProvider || message.workspaceId !== configuration.discordGuildId
    || message.externalUserId !== configuration.discordOwnerUserId) return null;

  const user = database.prepare(`SELECT * FROM users WHERE transport = ? AND workspace_id = ? AND external_user_id = ?
    AND role = 'owner' AND state = 'active' AND deleted_at IS NULL`).get(
    message.transport, message.workspaceId, message.externalUserId,
  ) as UserRecord | undefined;
  if (!user) return null;

  if (message.parentConversationId === null) {
    if (message.conversationId !== configuration.discordAllowedChannelId || !message.botUserId) return null;
    if (message.mentionedBotUserIds.length !== 1 || message.mentionedBotUserIds[0] !== message.botUserId) return null;
    return { kind: "top-level", user };
  }

  if (message.parentConversationId !== configuration.discordAllowedChannelId) return null;
  const session = database.prepare(`SELECT * FROM sessions WHERE transport = ? AND workspace_id = ?
    AND parent_conversation_id = ? AND conversation_id = ? AND state = 'active' AND deleted_at IS NULL`).get(
    message.transport, message.workspaceId, message.parentConversationId, message.conversationId,
  ) as SessionRecord | undefined;
  return session ? { kind: "bound-thread", user, session } : null;
}
