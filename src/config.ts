import { readFile } from "node:fs/promises";

const requiredKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_OWNER_USER_ID",
  "DISCORD_STATUS_CHANNEL_ID",
  "CHAT_PROVIDER",
  "AGENT_PROVIDER",
  "MEMORY_REVIEW_TIME",
  "MEMORY_REVIEW_MAX_CHARS",
] as const;

export type Configuration = {
  discordBotToken: string;
  discordGuildId: string;
  discordOwnerUserId: string;
  discordStatusChannelId: string;
  chatProvider: "discord";
  agentProvider: "codex" | "claude" | "opencode";
  claudeModel?: string;
  memoryReviewTime: string;
  memoryReviewMaxChars: number;
};

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.join("\n")}`);
    this.name = "ConfigurationError";
  }
}

export function validateConfiguration(values: Record<string, string | undefined>): Configuration {
  const issues = requiredKeys.filter((key) => !values[key]?.trim()).map((key) => `${key} is required`);
  if (values.CHAT_PROVIDER && values.CHAT_PROVIDER !== "discord") {
    issues.push("CHAT_PROVIDER must be discord");
  }
  if (values.AGENT_PROVIDER && !["codex", "claude", "opencode"].includes(values.AGENT_PROVIDER)) {
    issues.push("AGENT_PROVIDER must be codex, claude, or opencode");
  }
  const claudeModel = values.AGENT_PROVIDER === "claude" ? values.CLAUDE_MODEL?.trim() || undefined : undefined;
  if (claudeModel && !/^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$/.test(claudeModel)) {
    issues.push("CLAUDE_MODEL must start with a letter or digit and contain only letters, digits, and . _ : - [ ]");
  }
  if (values.MEMORY_REVIEW_TIME && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.MEMORY_REVIEW_TIME)) {
    issues.push("MEMORY_REVIEW_TIME must be HH:MM");
  }
  const limit = Number(values.MEMORY_REVIEW_MAX_CHARS);
  if (values.MEMORY_REVIEW_MAX_CHARS && (!Number.isSafeInteger(limit) || limit <= 0)) {
    issues.push("MEMORY_REVIEW_MAX_CHARS must be a positive integer");
  }
  if (issues.length > 0) throw new ConfigurationError(issues);

  return {
    discordBotToken: values.DISCORD_BOT_TOKEN!,
    discordGuildId: values.DISCORD_GUILD_ID!,
    discordOwnerUserId: values.DISCORD_OWNER_USER_ID!,
    discordStatusChannelId: values.DISCORD_STATUS_CHANNEL_ID!,
    chatProvider: "discord",
    agentProvider: values.AGENT_PROVIDER as Configuration["agentProvider"],
    ...(claudeModel ? { claudeModel } : {}),
    memoryReviewTime: values.MEMORY_REVIEW_TIME!,
    memoryReviewMaxChars: limit,
  };
}

export async function loadConfiguration(envFile: string): Promise<Configuration> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(envFile, "utf8")).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return validateConfiguration(values);
}
