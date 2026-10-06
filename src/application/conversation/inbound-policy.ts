import type {
  ConversationPolicyConfiguration,
  ConversationSession,
  ConversationStore,
  ConversationUser,
  IncomingConversationMessage,
} from "./ports.js";

export type EligibleIncomingMessage =
  | { kind: "top-level"; user: ConversationUser }
  | { kind: "bound-thread"; user: ConversationUser; session: ConversationSession }
  | { kind: "reset-thread"; user: ConversationUser; previous: ConversationSession };

/**
 * Decide whether an inbound message can enter a conversation.
 *
 * This is an application policy, so it depends on the conversation store port
 * and a transport-neutral message shape rather than Discord or PostgreSQL
 * implementations.
 */
export async function classifyIncomingMessage(
  database: ConversationStore,
  configuration: ConversationPolicyConfiguration,
  message: IncomingConversationMessage,
): Promise<EligibleIncomingMessage | null> {
  if (message.authorIsBot || message.transport !== configuration.chatProvider || message.workspaceId !== configuration.discordGuildId) {
    return null;
  }

  const user = await database.findUser(message.transport, message.workspaceId, message.externalUserId);
  if (!user) return null;

  if (message.parentConversationId === null) {
    if (message.conversationId === configuration.discordStatusChannelId || !message.botUserId) return null;
    if (message.mentionedBotUserIds.length !== 1 || message.mentionedBotUserIds[0] !== message.botUserId) return null;
    return { kind: "top-level", user };
  }

  if (message.parentConversationId === configuration.discordStatusChannelId) return null;
  const session = await database.findSessionByConversation(
    message.transport,
    message.workspaceId,
    message.parentConversationId,
    message.conversationId,
  );
  if (session?.state === "active") return { kind: "bound-thread", user, session };
  return session?.state === "ended" && session.updated_by === "user:owner" && session.user_id === user.id
    ? { kind: "reset-thread", user, previous: session }
    : null;
}
