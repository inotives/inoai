import type { Configuration } from "./config.js";
import type { SessionRecord, UserRecord } from "./database.js";
import type { OperationalStore } from "./operational-store.js";
import type { IncomingMessage } from "./transport.js";

export type EligibleIncomingMessage =
  | { kind: "top-level"; user: UserRecord }
  | { kind: "bound-thread"; user: UserRecord; session: SessionRecord }
  | { kind: "reset-thread"; user: UserRecord; previous: SessionRecord };

export async function classifyIncomingMessage(
  database: Pick<OperationalStore, "findUser" | "findSessionByConversation">,
  configuration: Configuration,
  message: IncomingMessage,
): Promise<EligibleIncomingMessage | null> {
  if (message.authorIsBot || message.transport !== configuration.chatProvider || message.workspaceId !== configuration.discordGuildId
  ) return null;

  const user = await database.findUser(message.transport, message.workspaceId, message.externalUserId);
  if (!user) return null;

  if (message.parentConversationId === null) {
    if (message.conversationId === configuration.discordStatusChannelId || !message.botUserId) return null;
    if (message.mentionedBotUserIds.length !== 1 || message.mentionedBotUserIds[0] !== message.botUserId) return null;
    return { kind: "top-level", user };
  }

  if (message.parentConversationId === configuration.discordStatusChannelId) return null;
  const session = await database.findSessionByConversation(message.transport, message.workspaceId, message.parentConversationId, message.conversationId);
  if (session?.state === "active") return { kind: "bound-thread", user, session };
  return session?.state === "ended" && session.updated_by === "user:owner" && session.user_id === user.id
    ? { kind: "reset-thread", user, previous: session } : null;
}
