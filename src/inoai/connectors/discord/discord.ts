import { ButtonStyle, ChannelType, Client, ComponentType, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { APIActionRowComponent, APIButtonComponentWithCustomId, ButtonInteraction, Message } from "discord.js";

import type { Configuration } from "../../agent-instance/config.js";
import { KnownDeliveryFailure } from "../../conversation/transport-port.js";
import type { ConversationTransport, MessageButton } from "../../conversation/transport-port.js";
import type { ButtonClick, ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../../transport/ports.js";

export type { ButtonClick, ChatTransport, IncomingMessage, MessageButton, ThreadControl, TransportHealth } from "../../transport/ports.js";

export { KnownDeliveryFailure } from "../../conversation/transport-port.js";

export class DiscordTransport implements ChatTransport {
  private state: TransportHealth["state"] = "idle";
  private started = false;
  private cancelStartup: (() => void) | null = null;
  private buttonHandler: ((click: ButtonClick) => Promise<void>) | null = null;

  constructor(private readonly token: string, private readonly client: Client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  })) {}

  async start(onIncomingMessage: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, onFailure?: (error: Error) => void, onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
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
    this.client.on(Events.InteractionCreate, (interaction) => {
      // Button clicks are accepted in every channel, including the status channel whose messages are ignored: Memory
      // proposal cards live there.
      if (this.state === "ready" && !interaction.isChatInputCommand() && interaction.isButton() && interaction.customId.startsWith("inoai:")) {
        void this.handleButton(interaction);
        return;
      }
      if (this.state !== "ready" || !onControl || !interaction.isChatInputCommand() || interaction.commandName !== "inoai") return;
      const command = interaction.options.getSubcommand(false);
      const group = interaction.options.getSubcommandGroup(false);
      if (command !== "status" && command !== "cancel" && command !== "reset"
         && !(group === "task" && (command === "create" || command === "list" || command === "pause" || command === "resume" || command === "run" || command === "cancel"))
         && !(group === "memory" && (command === "list" || command === "forget" || command === "review"))) return;
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await onControl({
          command: (group === "task" || group === "memory" ? `${group}-${command}` : command) as ThreadControl["command"],
          workspaceId: interaction.guildId, conversationId: interaction.channelId,
          parentConversationId: interaction.channel?.isThread() ? interaction.channel.parentId : null,
          guildTextChannelId: interaction.channel?.type === ChannelType.GuildText ? interaction.channelId
            : interaction.channel?.isThread() ? interaction.channel.parentId : null,
          externalUserId: interaction.user.id,
          conversationOwnedByBot: interaction.channel?.isThread() === true && interaction.channel.ownerId === this.client.user?.id,
          taskGoal: command === "create" ? interaction.options.getString("goal", true) : undefined,
          taskType: command === "create" ? interaction.options.getString("type", true) as "one_time" | "recurring" : undefined,
          intervalSeconds: command === "create" ? (() => {
            const interval = interaction.options.getInteger("interval");
            const unit = interaction.options.getString("unit");
            return interval && unit ? interval * (unit === "days" ? 86400 : 3600) : undefined;
          })() : undefined,
           taskId: group === "task" && (command === "pause" || command === "resume" || command === "run" || command === "cancel") ? interaction.options.getInteger("id") ?? undefined : undefined,
          memoryId: group === "memory" && command === "forget" ? interaction.options.getInteger("id", true) : undefined,
          respond: (text) => interaction.editReply({ content: text, allowedMentions: { parse: [] } }).then(() => undefined),
        });
      })().catch(() => { void interaction.editReply({ content: "Control unavailable. Please try again." }).catch(() => undefined); });
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

  onButtonClick(handler: (click: ButtonClick) => Promise<void>): void {
    this.buttonHandler = handler;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    let responded = false;
    try {
      if (!this.buttonHandler) throw new Error("No button handler");
      await this.buttonHandler({
        customId: interaction.customId, workspaceId: interaction.guildId, conversationId: interaction.channelId,
        messageId: interaction.message.id, externalUserId: interaction.user.id,
        replyEphemeral: async (text) => {
          responded = true;
          await interaction.reply({ content: text.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        },
        updateMessage: async (text, buttons = []) => {
          responded = true;
          await interaction.update({ content: text.slice(0, 1900), components: buttonRows(buttons), allowedMentions: { parse: [] } });
        },
      });
      if (!responded) throw new Error("Button click was not answered");
    } catch {
      const failure = { content: "Action unavailable. Please try again.", flags: MessageFlags.Ephemeral } as const;
      await (responded ? interaction.followUp(failure) : interaction.reply(failure)).catch(() => undefined);
    }
  }

  async registerThreadControls(guildId: string): Promise<void> {
    const command = new SlashCommandBuilder().setName("inoai").setDescription("Control this inoai conversation")
      .addSubcommand((part) => part.setName("status").setDescription("Show this conversation's state"))
      .addSubcommand((part) => part.setName("cancel").setDescription("Stop the active turn"))
      .addSubcommand((part) => part.setName("reset").setDescription("Start a fresh session after this turn"))
      .addSubcommandGroup((group) => group.setName("task").setDescription("Manage inoai Tasks")
        .addSubcommand((part) => part.setName("create").setDescription("Create a Task thread")
          .addStringOption((option) => option.setName("goal").setDescription("What the Task should do").setRequired(true))
          .addStringOption((option) => option.setName("type").setDescription("Task type").setRequired(true)
            .addChoices({ name: "One time", value: "one_time" }, { name: "Recurring", value: "recurring" }))
          .addIntegerOption((option) => option.setName("interval").setDescription("Recurring interval").setMinValue(1))
          .addStringOption((option) => option.setName("unit").setDescription("Recurring interval unit")
            .addChoices({ name: "Hours", value: "hours" }, { name: "Days", value: "days" })))
        .addSubcommand((part) => part.setName("list").setDescription("List Tasks"))
        .addSubcommand((part) => part.setName("pause").setDescription("Pause a Task")
          .addIntegerOption((option) => option.setName("id").setDescription("Task ID; optional in its thread").setMinValue(1)))
        .addSubcommand((part) => part.setName("resume").setDescription("Resume a Task")
          .addIntegerOption((option) => option.setName("id").setDescription("Task ID; optional in its thread").setMinValue(1)))
        .addSubcommand((part) => part.setName("run").setDescription("Run a Task now")
          .addIntegerOption((option) => option.setName("id").setDescription("Task ID; optional in its thread").setMinValue(1)))
        .addSubcommand((part) => part.setName("cancel").setDescription("Cancel a Task and its active run")
          .addIntegerOption((option) => option.setName("id").setDescription("Task ID; optional in its thread").setMinValue(1))))
      .addSubcommandGroup((group) => group.setName("memory").setDescription("Manage inoai Memory")
        .addSubcommand((part) => part.setName("list").setDescription("List active Memories"))
        .addSubcommand((part) => part.setName("forget").setDescription("Forget a Memory")
          .addIntegerOption((option) => option.setName("id").setDescription("Memory ID").setRequired(true).setMinValue(1)))
        .addSubcommand((part) => part.setName("review").setDescription("Run a Memory Review now")));
    if (!this.client.application) throw new Error("Discord application unavailable for command registration");
    await this.client.application.commands.create(command.toJSON(), guildId);
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

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId);
    if (channel?.type !== ChannelType.GuildText) throw new Error("Discord parent conversation must be a guild text channel");
    await channel.messages.delete(messageId);
  }

  async sendMessage(conversationId: string, text: string, replyToExternalMessageId?: string): Promise<string> {
    let channel;
    try { channel = await this.client.channels.fetch(conversationId); }
    catch { throw new KnownDeliveryFailure("Discord conversation could not be fetched before send"); }
    if (!channel?.isSendable()) throw new KnownDeliveryFailure("Discord conversation is not sendable");
    const message = await channel.send({ content: text, allowedMentions: { parse: [], repliedUser: false },
      ...(replyToExternalMessageId ? { reply: { messageReference: replyToExternalMessageId } } : {}) });
    return message.id;
  }

  async sendMessageWithButtons(conversationId: string, text: string, buttons: MessageButton[]): Promise<string> {
    if (buttons.length < 1 || buttons.length > 5) throw new KnownDeliveryFailure("A button message needs 1-5 buttons");
    let channel;
    try { channel = await this.client.channels.fetch(conversationId); }
    catch { throw new KnownDeliveryFailure("Discord conversation could not be fetched before send"); }
    if (!channel?.isSendable()) throw new KnownDeliveryFailure("Discord conversation is not sendable");
    const message = await channel.send({ content: text.slice(0, 1900), components: buttonRows(buttons), allowedMentions: { parse: [] } });
    return message.id;
  }

  async editMessage(conversationId: string, messageId: string, text: string, buttons: MessageButton[] = []): Promise<void> {
    if (buttons.length > 5) throw new RangeError("A message row holds at most 5 buttons");
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isTextBased()) throw new Error("Discord conversation is not text based");
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== this.client.user?.id) throw new Error("Cannot edit another author's message");
    await message.edit({ content: text.slice(0, 1900), components: buttonRows(buttons), allowedMentions: { parse: [] } });
  }

  async uploadFile(conversationId: string, filePath: string, name: string): Promise<string> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isSendable()) throw new KnownDeliveryFailure("Discord conversation is not sendable");
    const message = await channel.send({ content: name.slice(0, 1900),
      files: [{ attachment: filePath, name: name.split("/").at(-1) }], allowedMentions: { parse: [] } });
    return message.id;
  }

  async showWorking(conversationId: string): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isSendable()) return;
    await channel.sendTyping();
  }

  async disableLegacyApprovalControls(conversationId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel?.isTextBased()) throw new Error("Discord conversation is not text based");
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== this.client.user?.id) throw new Error("Cannot edit another bot's approval message");
    await message.edit({ content: "A saved Codex approval could not be resumed after restart. No action was approved.", components: [] });
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

const buttonStyles = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;

function buttonRows(buttons: MessageButton[]): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
  if (!buttons.length) return [];
  return [{ type: ComponentType.ActionRow, components: buttons.map((button) => ({
    type: ComponentType.Button, style: buttonStyles[button.style], label: button.label, custom_id: button.customId,
  })) }];
}

export function createChatTransport(configuration: Configuration, client?: Client): ChatTransport {
  switch (configuration.chatProvider) {
    case "discord": return new DiscordTransport(configuration.discordBotToken, client);
  }
}
