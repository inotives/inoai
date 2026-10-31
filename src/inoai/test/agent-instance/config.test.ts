import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError, loadConfiguration, validateConfiguration } from "../../agent-instance/config.js";
import { start } from "../../../index.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";

const validValues = {
  DISCORD_BOT_TOKEN: "token",
  DISCORD_GUILD_ID: "guild",
  DISCORD_OWNER_USER_ID: "owner",
  DISCORD_STATUS_CHANNEL_ID: "status",
  CHAT_PROVIDER: "discord",
  AGENT_PROVIDER: "codex",
  POSTGRES_URL: "postgresql://inoai_sync:secret@example.test:5432/app",
  POSTGRES_ISOLATION_MODE: "application",
  AGENT_INSTANCE_ID: "agent-inoai-planner",
  POSTGRES_POOL_MAX: "2",
  POSTGRES_CONNECT_TIMEOUT_MS: "5000",
  POSTGRES_IDLE_TIMEOUT_MS: "10000",
  POSTGRES_QUERY_TIMEOUT_MS: "30000",
  MEMORY_REVIEW_TIME: "06:00",
  MEMORY_REVIEW_MAX_CHARS: "20000",
};

test("loads a complete local configuration without external services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const envFile = join(directory, ".env");
    await writeFile(envFile, Object.entries(validValues).map(([key, value]) => `${key}=${value}`).join("\n"));
    assert.equal((await loadConfiguration(envFile)).memoryReviewMaxChars, 20000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports every missing required setting by name", () => {
  assert.throws(() => validateConfiguration({}), (error: unknown) => {
    assert(error instanceof ConfigurationError);
    for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_OWNER_USER_ID", "DISCORD_STATUS_CHANNEL_ID", "CHAT_PROVIDER", "AGENT_PROVIDER", "AGENT_INSTANCE_ID", "MEMORY_REVIEW_TIME", "MEMORY_REVIEW_MAX_CHARS"]) assert.match(error.message, new RegExp(key));
    return true;
  });
});

test("requires the status channel setting without accepting the former channel key", () => {
  const { DISCORD_STATUS_CHANNEL_ID, ...oldValues } = validValues;
  assert.throws(() => validateConfiguration({ ...oldValues, DISCORD_ALLOWED_CHANNEL_ID: DISCORD_STATUS_CHANNEL_ID }), (error: unknown) => {
    assert(error instanceof ConfigurationError);
    assert.match(error.message, /DISCORD_STATUS_CHANNEL_ID is required/);
    assert.doesNotMatch(error.message, /token|DISCORD_ALLOWED_CHANNEL_ID/);
    return true;
  });
});

test("rejects unsupported providers and invalid review settings", () => {
  assert.throws(
    () => validateConfiguration({ ...validValues, CHAT_PROVIDER: "slack", AGENT_PROVIDER: "other", MEMORY_REVIEW_TIME: "25:00", MEMORY_REVIEW_MAX_CHARS: "0" }),
    ConfigurationError,
  );
});

test("validates without PostgreSQL and does not read leftover settings", () => {
  const values = Object.fromEntries(Object.entries(validValues).filter(([key]) => !key.startsWith("POSTGRES_")));
  assert.equal(validateConfiguration(values).agentInstanceId, "agent-inoai-planner");
  for (const key of ["POSTGRES_URL", "POSTGRES_ISOLATION_MODE", "POSTGRES_POOL_MAX", "POSTGRES_LEASE_TTL_MS"]) {
    Object.defineProperty(values, key, { get() { throw new Error("PostgreSQL value was read"); } });
  }
  assert.equal(validateConfiguration(values).agentProvider, "codex");
  assert.equal("postgresUrl" in validateConfiguration(values), false);
});

test("enforces the normalized Agent Instance slug", () => {
  for (const value of ["agent-Inoai", "inoai-planner", "agent-", "agent_planner", `agent-${"a".repeat(60)}`]) {
    assert.throws(() => validateConfiguration({ ...validValues, AGENT_INSTANCE_ID: value }), ConfigurationError);
  }
});

test("accepts the Claude provider with a blank or well-formed optional model", () => {
  const blank = validateConfiguration({ ...validValues, AGENT_PROVIDER: "claude", CLAUDE_MODEL: "" });
  assert.equal(blank.agentProvider, "claude");
  assert.equal(blank.claudeModel, undefined);
  assert.equal(validateConfiguration({ ...validValues, AGENT_PROVIDER: "claude" }).claudeModel, undefined);
  for (const model of ["opus", "haiku", "sonnet", "claude-opus-5-5", "claude-sonnet-5-5[1m]", "claude-opus-4-1", "claude-sonnet-4-5-20250929", "claude-opus-5-5[1m]", "us.anthropic.claude:1"]) {
    assert.equal(validateConfiguration({ ...validValues, AGENT_PROVIDER: "claude", CLAUDE_MODEL: model }).claudeModel, model);
  }
});

test("rejects a malformed Claude model and names unsupported agent providers", () => {
  for (const model of ["opus 4", "sonnet;rm", "$(id)", "a|b", "`x`", "m&n", "x>y", "'q'", "--dangerously-skip-permissions", "-p", "--settings"]) {
    assert.throws(() => validateConfiguration({ ...validValues, AGENT_PROVIDER: "claude", CLAUDE_MODEL: model }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /CLAUDE_MODEL must start with a letter or digit and contain only/);
      return true;
    });
  }
  for (const provider of ["other", "OpenCode", "opencode "]) {
    assert.throws(() => validateConfiguration({ ...validValues, AGENT_PROVIDER: provider }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /AGENT_PROVIDER must be codex, claude, or opencode/);
      return true;
    });
  }
});

test("accepts the OpenCode provider without a model setting", () => {
  const configuration = validateConfiguration({ ...validValues, AGENT_PROVIDER: "opencode", CLAUDE_MODEL: "opus 4" });
  assert.equal(configuration.agentProvider, "opencode");
  assert.equal(configuration.claudeModel, undefined);
});

test("ignores CLAUDE_MODEL for a Codex home", () => {
  const configuration = validateConfiguration({ ...validValues, CLAUDE_MODEL: "opus 4" });
  assert.equal(configuration.agentProvider, "codex");
  assert.equal(configuration.claudeModel, undefined);
});

test("parses optional CLAUDE_ALLOWED_TOOLS for a Claude home", () => {
  const claude = { ...validValues, AGENT_PROVIDER: "claude" };
  assert.equal(validateConfiguration(claude).claudeAllowedTools, undefined);
  assert.equal(validateConfiguration({ ...claude, CLAUDE_ALLOWED_TOOLS: "  " }).claudeAllowedTools, undefined);
  assert.deepEqual(validateConfiguration({ ...claude, CLAUDE_ALLOWED_TOOLS: " WebFetch , WebSearch,mcp__plugin_context-mode_context-mode__ctx_fetch_and_index " }).claudeAllowedTools,
    ["WebFetch", "WebSearch", "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index"]);
  // Blank is unset, so a shared sample line does not break other providers.
  assert.equal(validateConfiguration({ ...validValues, CLAUDE_ALLOWED_TOOLS: "" }).claudeAllowedTools, undefined);
});

test("rejects malformed CLAUDE_ALLOWED_TOOLS and any value for a non-Claude home", () => {
  const claude = { ...validValues, AGENT_PROVIDER: "claude" };
  for (const value of ["WebFetch,", ",WebFetch", "WebFetch,,WebSearch", "WebFetch, ,WebSearch", "Web Fetch", "Bash(git status:*)", "Bash(*)",
    "--dangerously-skip-permissions", "-p", "WebFetch;rm", "$(id)", "`x`", "a|b", "mcp__x/y", "Edit*", "_x", "1tool", "WebFetch=x", `a${"b".repeat(128)}`]) {
    assert.throws(() => validateConfiguration({ ...claude, CLAUDE_ALLOWED_TOOLS: value }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /CLAUDE_ALLOWED_TOOLS must be a comma-separated list of tool names/);
      return true;
    }, value);
  }
  for (const provider of ["codex", "opencode"]) {
    assert.throws(() => validateConfiguration({ ...validValues, AGENT_PROVIDER: provider, CLAUDE_ALLOWED_TOOLS: "WebFetch" }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /CLAUDE_ALLOWED_TOOLS is only supported when AGENT_PROVIDER is claude/);
      return true;
    });
  }
});

test("rejects an unsupported provider before acquiring the runtime lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, Object.entries({ ...validValues, CHAT_PROVIDER: "slack" }).map(([key, value]) => `${key}=${value}`).join("\n"));
    await assert.rejects(start(directory), ConfigurationError);
    const release = await acquireRuntimeHomeLock(home);
    await release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts an optional task channel and rejects a malformed one", () => {
  assert.equal(validateConfiguration(validValues).discordTaskChannelId, undefined);
  assert.equal("discordTaskChannelId" in validateConfiguration({ ...validValues, DISCORD_TASK_CHANNEL_ID: " " }), false);
  assert.equal(validateConfiguration({ ...validValues, DISCORD_TASK_CHANNEL_ID: " 123456789012345678 " }).discordTaskChannelId, "123456789012345678");
  assert.throws(() => validateConfiguration({ ...validValues, DISCORD_TASK_CHANNEL_ID: "tasks" }), (error: unknown) => {
    assert(error instanceof ConfigurationError);
    assert.match(error.message, /DISCORD_TASK_CHANNEL_ID must be a Discord channel ID/);
    return true;
  });
});

test("resolves OWNER_TIMEZONE when absent, blank, valid, or invalid", async () => {
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(validateConfiguration(validValues).ownerTimeZone, hostZone);
  assert.equal(validateConfiguration({ ...validValues, OWNER_TIMEZONE: "" }).ownerTimeZone, hostZone);
  assert.equal(validateConfiguration({ ...validValues, OWNER_TIMEZONE: "   " }).ownerTimeZone, hostZone);
  assert.equal(validateConfiguration({ ...validValues, OWNER_TIMEZONE: " Asia/Singapore " }).ownerTimeZone, "Asia/Singapore");
  for (const value of ["Mars/Olympus", "+08:00", "not a zone"]) {
    assert.throws(() => validateConfiguration({ ...validValues, OWNER_TIMEZONE: value }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /OWNER_TIMEZONE must be a known IANA time zone/);
      return true;
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const envFile = join(directory, ".env");
    await writeFile(envFile, [...Object.entries(validValues).map(([key, value]) => `${key}=${value}`), "# OWNER_TIMEZONE=Asia/Tokyo", "OWNER_TIMEZONE=Europe/London"].join("\n"));
    assert.equal((await loadConfiguration(envFile)).ownerTimeZone, "Europe/London");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
