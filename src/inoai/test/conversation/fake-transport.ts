/* Test-only fake Discord transport with buttons, edits, and clicks. Not a test file itself. */
import type { ButtonClick, ChatTransport, IncomingMessage, MessageButton, ThreadControl, TransportHealth } from "../../transport/ports.js";

export class FakeTransport implements ChatTransport {
  private incoming?: (message: IncomingMessage) => void;
  private onControl?: (control: ThreadControl) => Promise<void>;
  private onButton?: (click: ButtonClick) => Promise<void>;
  private count = 0;
  readonly sent: string[] = [];
  readonly buttons = new Map<string, MessageButton[]>();
  readonly edits: { messageId: string; text: string; buttons: MessageButton[] }[] = [];
  /** Every sent message with its conversation, in order. */
  readonly messages: { conversationId: string; id: string; text: string }[] = [];
  readonly threads: { parentId: string; starterId: string; name: string; id: string }[] = [];
  readonly deletedThreads: string[] = [];
  readonly deletedMessages: string[] = [];
  failThread = false;
  failButtons = false;
  state: TransportHealth["state"] = "ready";
  start(onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.incoming = onIncoming;
    this.onControl = onControl;
    return Promise.resolve(onReady?.()).then(() => {});
  }
  emit(message: IncomingMessage): void { this.incoming?.(message); }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "thread-a",
      parentConversationId: "channel", externalUserId: "owner", conversationOwnedByBot: true,
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  onButtonClick(handler: (click: ButtonClick) => Promise<void>): void { this.onButton = handler; }
  /** Simulates a button click and returns the private reply or message update it produced. */
  async click(messageId: string, customId: string, overrides: Partial<ButtonClick> = {}): Promise<{ reply?: string; update?: { text: string; buttons: MessageButton[] } }> {
    const answer: { reply?: string; update?: { text: string; buttons: MessageButton[] } } = {};
    await this.onButton?.({ customId, workspaceId: "guild", conversationId: "thread-a", messageId, externalUserId: "owner",
      replyEphemeral: async (text) => { answer.reply = text; },
      updateMessage: async (text, buttons = []) => { answer.update = { text, buttons }; this.buttons.set(messageId, buttons); },
      ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  /** When set, thread creation waits for it. */
  threadGate?: Promise<void>;
  async createConversation(parentId = "", starterId = "", name = ""): Promise<string> {
    await this.threadGate;
    if (this.failThread) throw new Error("Missing permission");
    const id = `thread-${++this.count}`;
    this.threads.push({ parentId, starterId, name, id });
    return id;
  }
  async deleteConversation(conversationId: string): Promise<void> { this.deletedThreads.push(conversationId); }
  async deleteMessage(_conversationId: string, messageId: string): Promise<void> { this.deletedMessages.push(messageId); }
  async sendMessage(conversationId: string, text: string): Promise<string> {
    this.sent.push(text);
    const id = `sent-${this.sent.length}`;
    this.messages.push({ conversationId, id, text });
    return id;
  }
  async sendMessageWithButtons(conversationId: string, text: string, buttons: MessageButton[]): Promise<string> {
    if (this.failButtons) throw new Error("Discord rejected the message");
    const id = await this.sendMessage(conversationId, text);
    this.buttons.set(id, buttons);
    return id;
  }
  async editMessage(_conversationId: string, messageId: string, text: string, buttons: MessageButton[] = []): Promise<void> {
    this.edits.push({ messageId, text, buttons });
    this.buttons.set(messageId, buttons);
  }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: this.state, botUserId: "inoai" }; }
}
