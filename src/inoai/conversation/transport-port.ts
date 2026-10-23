/** A message button. Its custom id is returned unchanged when the button is clicked. */
export type MessageButton = {
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
  customId: string;
};

/** Outbound conversation operations owned by the application layer. */
export interface ConversationTransport {
  sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string>;
  /** Sends text with one row of 1-5 buttons and returns the message id. */
  sendMessageWithButtons?(conversationId: string, text: string, buttons: MessageButton[]): Promise<string>;
  /** Replaces a message's text. Omitted or empty buttons remove its buttons. */
  editMessage?(conversationId: string, messageId: string, text: string, buttons?: MessageButton[]): Promise<void>;
  showWorking?(conversationId: string): Promise<void>;
}

/** A rejection known to have happened before an outbound message was sent. */
export class KnownDeliveryFailure extends Error {}
