import { readFile } from "node:fs/promises";

const requiredKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_OWNER_USER_ID",
  "DISCORD_STATUS_CHANNEL_ID",
  "CHAT_PROVIDER",
  "AGENT_PROVIDER",
  "POSTGRES_URL",
  "AGENT_INSTANCE_ID",
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
  postgresUrl: string;
  postgresIsolationMode: "application";
  agentInstanceId: string;
  postgresPoolMax: number;
  postgresConnectTimeoutMs: number;
  postgresIdleTimeoutMs: number;
  postgresQueryTimeoutMs: number;
  postgresLeaseTtlMs: number;
  postgresLeaseRefreshMs: number;
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
  const postgresUrl = values.POSTGRES_URL?.trim();
  if (postgresUrl) {
    try {
      const parsed = new URL(postgresUrl);
      if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname) throw new Error();
    } catch {
      issues.push("POSTGRES_URL must be a valid PostgreSQL URL");
    }
  }
  const postgresIsolationMode = values.POSTGRES_ISOLATION_MODE?.trim() || "application";
  if (postgresIsolationMode !== "application") {
    issues.push("POSTGRES_ISOLATION_MODE must be application; database mode is not supported");
  }
  const agentInstanceId = values.AGENT_INSTANCE_ID?.trim();
  if (agentInstanceId && (!/^agent-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentInstanceId) || agentInstanceId.length > 63)) {
    issues.push("AGENT_INSTANCE_ID must be a lowercase agent- slug of at most 63 characters");
  }
  const boundedInteger = (key: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = values[key]?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      issues.push(`${key} must be an integer between ${minimum} and ${maximum}`);
      return fallback;
    }
    return parsed;
  };
  const postgresPoolMax = boundedInteger("POSTGRES_POOL_MAX", 2, 1, 10);
  const postgresConnectTimeoutMs = boundedInteger("POSTGRES_CONNECT_TIMEOUT_MS", 5_000, 1_000, 30_000);
  const postgresIdleTimeoutMs = boundedInteger("POSTGRES_IDLE_TIMEOUT_MS", 10_000, 1_000, 300_000);
  const postgresQueryTimeoutMs = boundedInteger("POSTGRES_QUERY_TIMEOUT_MS", 30_000, 1_000, 120_000);
  const postgresLeaseTtlMs = boundedInteger("POSTGRES_LEASE_TTL_MS", 30_000, 5_000, 600_000);
  const postgresLeaseRefreshMs = boundedInteger("POSTGRES_LEASE_REFRESH_MS", Math.floor(postgresLeaseTtlMs / 3), 1_000, 300_000);
  if (postgresLeaseRefreshMs >= postgresLeaseTtlMs) issues.push("POSTGRES_LEASE_REFRESH_MS must be less than POSTGRES_LEASE_TTL_MS");
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
    postgresUrl: postgresUrl!,
    postgresIsolationMode: "application",
    agentInstanceId: agentInstanceId!,
    postgresPoolMax,
    postgresConnectTimeoutMs,
    postgresIdleTimeoutMs,
    postgresQueryTimeoutMs,
    postgresLeaseTtlMs,
    postgresLeaseRefreshMs,
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
