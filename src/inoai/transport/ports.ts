import type { ConversationTransport } from "../conversation/transport-port.js";

export type IncomingMessage = {
  transport: "discord";
  workspaceId: string | null;
  conversationId: string;
  parentConversationId: string | null;
  externalMessageId: string;
  externalUserId: string;
  body: string;
  replyToExternalMessageId: string | null;
  mentionedUserIds: string[];
  mentionedBotUserIds: string[];
  botUserId: string | null;
  authorIsBot: boolean;
};

export type TransportHealth = {
  state: "idle" | "connecting" | "ready" | "reconnecting" | "error" | "stopped";
  botUserId: string | null;
};

export type ThreadControl = {
  command: "status" | "cancel" | "reset";
  workspaceId: string | null;
  conversationId: string;
  parentConversationId: string | null;
  externalUserId: string;
  conversationOwnedByBot: boolean;
  respond(text: string): Promise<void>;
};

export interface ChatTransport extends ConversationTransport {
  start(onIncomingMessage: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void>;
  registerThreadControls?(guildId: string): Promise<void>;
  stop(): Promise<void>;
  createConversation(parentConversationId: string, initialMessageId: string, name: string): Promise<string>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string>;
  showWorking?(conversationId: string): Promise<void>;
  disableLegacyApprovalControls?(conversationId: string, messageId: string): Promise<void>;
  publishHealth(targetConversationId: string, text: string, workspaceId: string): Promise<string>;
  health(): TransportHealth;
}
