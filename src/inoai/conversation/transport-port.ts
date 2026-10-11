/** Outbound conversation operations owned by the application layer. */
export interface ConversationTransport {
  sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string>;
  showWorking?(conversationId: string): Promise<void>;
}

/** A rejection known to have happened before an outbound message was sent. */
export class KnownDeliveryFailure extends Error {}
