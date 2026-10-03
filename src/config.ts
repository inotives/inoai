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
  agentName?: string;
  claudeModel?: string;
  memoryReviewTime: string;
  memoryReviewMaxChars: number;
  bigQuery?: BigQueryConfiguration;
  bigQueryIssue?: string;
};

export type BigQueryConfiguration = {
  projectId: string;
  datasetId: string;
  syncIntervalMinutes: number;
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
  const agentName = values.AGENT_NAME?.trim() || undefined;
  if (agentName && (agentName.length > 100 || /[\u0000-\u001f\u007f]/.test(agentName))) {
    issues.push("AGENT_NAME must be at most 100 characters and contain no control characters");
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

  // An interval by itself is only a default/override, not an enable signal.
  // BigQuery remains disabled until its destination is configured.
  const bigQueryValuesPresent = [values.BIGQUERY_PROJECT_ID, values.BIGQUERY_DATASET_ID]
    .some((value) => value?.trim());
  let bigQuery: BigQueryConfiguration | undefined;
  let bigQueryIssue: string | undefined;
  if (bigQueryValuesPresent) {
    const projectId = values.BIGQUERY_PROJECT_ID?.trim() ?? "";
    const datasetId = values.BIGQUERY_DATASET_ID?.trim() ?? "";
    const intervalText = values.BIGQUERY_SYNC_INTERVAL_MINUTES?.trim() || "60";
    const interval = Number(intervalText);
    const optionalIssues: string[] = [];
    if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) optionalIssues.push("project id");
    if (!datasetId || !/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(datasetId)) optionalIssues.push("dataset id");
    if (!/^\d+$/.test(intervalText) || !Number.isSafeInteger(interval) || interval <= 0) optionalIssues.push("sync interval");
    if (optionalIssues.length > 0) {
      bigQueryIssue = `BigQuery sync disabled: invalid ${optionalIssues.join(", ")}`;
    } else {
      bigQuery = { projectId, datasetId, syncIntervalMinutes: interval };
    }
  }

  return {
    discordBotToken: values.DISCORD_BOT_TOKEN!,
    discordGuildId: values.DISCORD_GUILD_ID!,
    discordOwnerUserId: values.DISCORD_OWNER_USER_ID!,
    discordStatusChannelId: values.DISCORD_STATUS_CHANNEL_ID!,
    chatProvider: "discord",
    agentProvider: values.AGENT_PROVIDER as Configuration["agentProvider"],
    ...(agentName ? { agentName } : {}),
    ...(claudeModel ? { claudeModel } : {}),
    memoryReviewTime: values.MEMORY_REVIEW_TIME!,
    memoryReviewMaxChars: limit,
    ...(bigQuery ? { bigQuery } : {}),
    ...(bigQueryIssue ? { bigQueryIssue } : {}),
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
