import type { ConversationTransport, MessageButton } from "../conversation/transport-port.js";

export type { MessageButton } from "../conversation/transport-port.js";

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
  command: "status" | "cancel" | "reset" | "task-create" | "task-list" | "task-pause" | "task-resume" | "task-run" | "task-cancel"
    | "memory-list" | "memory-forget" | "memory-review";
  workspaceId: string | null;
  conversationId: string;
  parentConversationId: string | null;
  guildTextChannelId?: string | null;
  externalUserId: string;
  conversationOwnedByBot: boolean;
  taskGoal?: string;
  taskType?: "one_time" | "recurring";
  intervalSeconds?: number;
  taskId?: number;
  memoryId?: number;
  respond(text: string): Promise<void>;
};

/** A click on a button whose custom id starts with `inoai:`. */
export type ButtonClick = {
  customId: string;
  workspaceId: string | null;
  conversationId: string;
  messageId: string;
  externalUserId: string;
  /** Replies privately to the clicking user. */
  replyEphemeral(text: string): Promise<void>;
  /** Acknowledges the click by replacing the message text. Omitted or empty buttons remove its buttons. */
  updateMessage(text: string, buttons?: MessageButton[]): Promise<void>;
};

export interface ChatTransport extends ConversationTransport {
  start(onIncomingMessage: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void>;
  registerThreadControls?(guildId: string): Promise<void>;
  /** Sets the callback for `inoai:` button clicks. A click must call replyEphemeral or updateMessage once. */
  onButtonClick?(handler: (click: ButtonClick) => Promise<void>): void;
  stop(): Promise<void>;
  createConversation(parentConversationId: string, initialMessageId: string, name: string): Promise<string>;
  deleteConversation(conversationId: string): Promise<void>;
  deleteMessage?(conversationId: string, messageId: string): Promise<void>;
  sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string>;
  uploadFile?(conversationId: string, filePath: string, name: string): Promise<string>;
  showWorking?(conversationId: string): Promise<void>;
  disableLegacyApprovalControls?(conversationId: string, messageId: string): Promise<void>;
  publishHealth(targetConversationId: string, text: string, workspaceId: string): Promise<string>;
  health(): TransportHealth;
}
