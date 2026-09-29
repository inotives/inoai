import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import type { Message } from "discord.js";

import type { Configuration } from "./config.js";

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

export interface ChatTransport {
  start(onIncomingMessage: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, onFailure?: (error: Error) => void): Promise<void>;
  stop(): Promise<void>;
  createConversation(parentConversationId: string, initialMessageId: string, name: string): Promise<string>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string>;
  publishHealth(targetConversationId: string, text: string, workspaceId: string): Promise<string>;
  health(): TransportHealth;
}

export class DiscordTransport implements ChatTransport {
  private state: TransportHealth["state"] = "idle";
  private started = false;
  private cancelStartup: (() => void) | null = null;

  constructor(private readonly token: string, private readonly client: Client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  })) {}

  async start(onIncomingMessage: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, onFailure?: (error: Error) => void): Promise<void> {
    if (this.started) throw new Error("Discord transport already started");
    this.started = true;
    this.state = "connecting";
    let ready!: () => void;
    let readyFailed!: (error: unknown) => void;
    let firstConnection = true;
    const firstReady = new Promise<void>((resolve, reject) => { ready = resolve; readyFailed = reject; });
    const stopped = new Promise<never>((_, reject) => {
      this.cancelStartup = () => reject(new Error("Discord transport stopped during startup"));
    });
    this.client.on(Events.ClientReady, () => {
      if (this.state === "stopped" || this.state === "error") return;
      this.state = "ready";
      if (firstConnection) {
        firstConnection = false;
        void Promise.resolve().then(onReady).then(ready, readyFailed);
      }
    });
    this.client.on(Events.ShardDisconnect, () => {
      if (this.state === "stopped" || this.state === "error") return;
      this.state = "error";
      const error = new Error("Discord gateway disconnected permanently");
      readyFailed(error);
      onFailure?.(error);
    });
    this.client.on(Events.ShardReconnecting, () => { if (this.state !== "stopped" && this.state !== "error") this.state = "reconnecting"; });
    this.client.on(Events.ShardReady, () => { if (!firstConnection && this.state === "reconnecting") this.state = "ready"; });
    this.client.on(Events.ShardResume, () => { if (this.state !== "stopped" && this.state !== "error") this.state = "ready"; });
    this.client.on(Events.MessageCreate, (message: Message) => {
      if (this.state !== "ready") return;
      const mentionedUsers = [...message.mentions.parsedUsers.values()];
      onIncomingMessage({
        transport: "discord",
        workspaceId: message.guildId,
        conversationId: message.channelId,
        parentConversationId: message.channel.isThread() ? message.channel.parentId : null,
        externalMessageId: message.id,
        externalUserId: message.author.id,
        body: message.content,
        replyToExternalMessageId: message.reference?.messageId ?? null,
        mentionedUserIds: mentionedUsers.map((user) => user.id),
        mentionedBotUserIds: mentionedUsers.filter((user) => user.bot).map((user) => user.id),
        botUserId: this.client.user?.id ?? null,
        authorIsBot: message.author.bot,
      });
    });
    try {
      await Promise.race([Promise.all([this.client.login(this.token), firstReady]), stopped]);
    } catch (error) {
      if (this.health().state !== "stopped") {
        this.state = "error";
        await this.client.destroy();
      }
      throw error;
    } finally {
      this.cancelStartup = null;
    }
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.cancelStartup?.();
    await this.client.destroy();
  }

  async createConversation(parentConversationId: string, initialMessageId: string, name: string): Promise<string> {
    const channel = await this.client.channels.fetch(parentConversationId);
    if (channel?.type !== ChannelType.GuildText) throw new Error("Discord parent conversation must be a guild text channel");
    const thread = await channel.threads.create({ name, startMessage: initialMessageId });
    return thread.id;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isThread()) throw new Error("Discord conversation must be a thread");
    await channel.delete();
  }

  async sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isSendable()) throw new Error("Discord conversation is not sendable");
    const message = await channel.send({ content: text, ...(replyToExternalMessageId ? { reply: { messageReference: replyToExternalMessageId } } : {}) });
    return message.id;
  }

  async publishHealth(targetConversationId: string, text: string, workspaceId: string): Promise<string> {
    const channel = await this.client.channels.fetch(targetConversationId);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== workspaceId) {
      throw new Error("Discord health channel must be a text channel in the configured guild");
    }
    const message = await channel.send({ content: text });
    return message.id;
  }

  health(): TransportHealth {
    return { state: this.state, botUserId: this.client.user?.id ?? null };
  }
}

export function createChatTransport(configuration: Configuration, client?: Client): ChatTransport {
  switch (configuration.chatProvider) {
    case "discord": return new DiscordTransport(configuration.discordBotToken, client);
  }
}
