import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { normalizeTimeZone } from "../tasks/schedule.js";

const requiredKeys = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_OWNER_USER_ID",
  "DISCORD_STATUS_CHANNEL_ID",
  "CHAT_PROVIDER",
  "AGENT_PROVIDER",
  "AGENT_INSTANCE_ID",
  "MEMORY_REVIEW_TIME",
  "MEMORY_REVIEW_MAX_CHARS",
] as const;

const anthropicApiEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicApiEffort = (typeof anthropicApiEfforts)[number];
// Settings that only an anthropic-api home reads. Other homes ignore them with a warning (IP-0007 decision R1).
const anthropicApiSettings = ["ANTHROPIC_API_KEY", "ANTHROPIC_API_MODEL", "ANTHROPIC_API_EFFORT"] as const;
export const defaultAnthropicApiModel = "claude-opus-5-5";

export type Configuration = {
  discordBotToken: string;
  discordGuildId: string;
  discordOwnerUserId: string;
  discordStatusChannelId: string;
  discordTaskChannelId?: string;
  chatProvider: "discord";
  agentProvider: "codex" | "claude" | "opencode" | "anthropic-api";
  // Compatibility types for retained PostgreSQL tooling. Normal loading omits these fields.
  postgresUrl?: string;
  postgresIsolationMode?: "application";
  agentInstanceId: string;
  projectDirectory?: string;
  postgresPoolMax?: number;
  postgresConnectTimeoutMs?: number;
  postgresIdleTimeoutMs?: number;
  postgresQueryTimeoutMs?: number;
  postgresLeaseTtlMs?: number;
  postgresLeaseRefreshMs?: number;
  claudeModel?: string;
  /** Owner opt-in from `CLAUDE_ALLOWED_TOOLS`: plain Claude tool names passed as `--allowedTools` for Turns and Task runs. */
  claudeAllowedTools?: string[];
  /** Owner opt-in from `CLAUDE_PROMPT_CACHE_TTL=1h`: the Claude CLI caches prompts for 1 hour in Turns and Task runs. */
  claudePromptCacheOneHour?: true;
  /** `ANTHROPIC_API_KEY` for an anthropic-api home. Never log or display it. */
  anthropicApiKey?: string;
  /** `ANTHROPIC_API_MODEL` for an anthropic-api home, or `claude-opus-5-5` when unset. */
  anthropicApiModel?: string;
  /** `ANTHROPIC_API_EFFORT` for an anthropic-api home. Unset means the model's own default. */
  anthropicApiEffort?: AnthropicApiEffort;
  /** Non-fatal configuration warnings for `validate` and startup to print. They name settings only, never values. */
  warnings?: string[];
  memoryReviewTime: string;
  memoryReviewMaxChars: number;
  /** IANA time zone for Discord-created Tasks: `OWNER_TIMEZONE`, or the host time zone when unset. */
  ownerTimeZone: string;
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
  if (values.AGENT_PROVIDER && !["codex", "claude", "opencode", "anthropic-api"].includes(values.AGENT_PROVIDER)) {
    issues.push("AGENT_PROVIDER must be codex, claude, opencode, or anthropic-api");
  }
  const agentInstanceId = values.AGENT_INSTANCE_ID?.trim();
  const projectDirectory = values.PROJECT_DIRECTORY?.trim() || undefined;
  if (projectDirectory && !isAbsolute(projectDirectory)) issues.push("PROJECT_DIRECTORY must be an absolute path");
  if (agentInstanceId && (!/^agent-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentInstanceId) || agentInstanceId.length > 63)) {
    issues.push("AGENT_INSTANCE_ID must be a lowercase agent- slug of at most 63 characters");
  }
  const discordTaskChannelId = values.DISCORD_TASK_CHANNEL_ID?.trim() || undefined;
  if (discordTaskChannelId && !/^\d+$/.test(discordTaskChannelId)) {
    issues.push("DISCORD_TASK_CHANNEL_ID must be a Discord channel ID");
  }
  const claudeModel = values.AGENT_PROVIDER === "claude" ? values.CLAUDE_MODEL?.trim() || undefined : undefined;
  if (claudeModel && !/^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$/.test(claudeModel)) {
    issues.push("CLAUDE_MODEL must start with a letter or digit and contain only letters, digits, and . _ : - [ ]");
  }
  // Plain tool names only (for example WebFetch or mcp__server__tool). Tool rules such as `Bash(git *)` are refused:
  // their spaces and wildcards widen permissions and the CLI splits its list on spaces.
  const allowedToolsValue = values.CLAUDE_ALLOWED_TOOLS?.trim() || undefined;
  const claudeAllowedTools = allowedToolsValue?.split(",").map((name) => name.trim());
  if (claudeAllowedTools && values.AGENT_PROVIDER !== "claude") {
    issues.push("CLAUDE_ALLOWED_TOOLS is only supported when AGENT_PROVIDER is claude");
  } else if (claudeAllowedTools?.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name))) {
    issues.push("CLAUDE_ALLOWED_TOOLS must be a comma-separated list of tool names; each must start with a letter and contain only letters, digits, _ and -");
  }
  const promptCacheTtl = values.CLAUDE_PROMPT_CACHE_TTL?.trim() || undefined;
  if (promptCacheTtl && values.AGENT_PROVIDER !== "claude") {
    issues.push("CLAUDE_PROMPT_CACHE_TTL is only supported when AGENT_PROVIDER is claude");
  } else if (promptCacheTtl && promptCacheTtl !== "1h") {
    issues.push("CLAUDE_PROMPT_CACHE_TTL must be 1h or blank");
  }
  // Messages name the setting only. They never include the key or another value.
  const anthropicApi = values.AGENT_PROVIDER === "anthropic-api";
  const warnings = anthropicApi ? [] : anthropicApiSettings.filter((key) => values[key]?.trim())
    .map((key) => `${key} is ignored because AGENT_PROVIDER is not anthropic-api`);
  const anthropicApiKey = anthropicApi ? values.ANTHROPIC_API_KEY?.trim() || undefined : undefined;
  if (anthropicApi && !anthropicApiKey) issues.push("ANTHROPIC_API_KEY is required when AGENT_PROVIDER is anthropic-api");
  const anthropicApiModel = anthropicApi ? values.ANTHROPIC_API_MODEL?.trim() || defaultAnthropicApiModel : undefined;
  const anthropicApiEffort = anthropicApi ? values.ANTHROPIC_API_EFFORT?.trim() || undefined : undefined;
  if (anthropicApiEffort && !(anthropicApiEfforts as readonly string[]).includes(anthropicApiEffort)) {
    issues.push("ANTHROPIC_API_EFFORT must be low, medium, high, xhigh, max, or blank");
  }
  if (values.MEMORY_REVIEW_TIME && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.MEMORY_REVIEW_TIME)) {
    issues.push("MEMORY_REVIEW_TIME must be HH:MM");
  }
  const limit = Number(values.MEMORY_REVIEW_MAX_CHARS);
  if (values.MEMORY_REVIEW_MAX_CHARS && (!Number.isSafeInteger(limit) || limit <= 0)) {
    issues.push("MEMORY_REVIEW_MAX_CHARS must be a positive integer");
  }
  const ownerTimeZoneValue = values.OWNER_TIMEZONE?.trim() || undefined;
  const ownerTimeZone = ownerTimeZoneValue ? normalizeTimeZone(ownerTimeZoneValue) : Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!ownerTimeZone) issues.push("OWNER_TIMEZONE must be a known IANA time zone, for example Asia/Singapore");
  if (issues.length > 0) throw new ConfigurationError(issues);

  return {
    discordBotToken: values.DISCORD_BOT_TOKEN!,
    discordGuildId: values.DISCORD_GUILD_ID!,
    discordOwnerUserId: values.DISCORD_OWNER_USER_ID!,
    discordStatusChannelId: values.DISCORD_STATUS_CHANNEL_ID!,
    ...(discordTaskChannelId ? { discordTaskChannelId } : {}),
    chatProvider: "discord",
    agentProvider: values.AGENT_PROVIDER as Configuration["agentProvider"],
    agentInstanceId: agentInstanceId!,
    ...(projectDirectory ? { projectDirectory } : {}),
    ...(claudeModel ? { claudeModel } : {}),
    ...(claudeAllowedTools ? { claudeAllowedTools } : {}),
    ...(promptCacheTtl ? { claudePromptCacheOneHour: true as const } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(anthropicApiModel ? { anthropicApiModel } : {}),
    ...(anthropicApiEffort ? { anthropicApiEffort: anthropicApiEffort as AnthropicApiEffort } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    memoryReviewTime: values.MEMORY_REVIEW_TIME!,
    memoryReviewMaxChars: limit,
    ownerTimeZone: ownerTimeZone!,
  };
}

/** Parses `.env` text into trimmed `KEY=value` pairs. Lines that start with `#` or have no key are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.startsWith("#")) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

export async function loadConfiguration(envFile: string): Promise<Configuration> {
  const values = Object.fromEntries(Object.entries(parseEnvText(await readFile(envFile, "utf8"))).filter(([key]) => !key.startsWith("POSTGRES_")));
  return validateConfiguration(values);
}
