import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError, loadConfiguration, validateConfiguration } from "../config.js";
import { start } from "../index.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "../runtime-home.js";

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
    for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_OWNER_USER_ID", "DISCORD_STATUS_CHANNEL_ID", "CHAT_PROVIDER", "AGENT_PROVIDER", "POSTGRES_URL", "AGENT_INSTANCE_ID", "MEMORY_REVIEW_TIME", "MEMORY_REVIEW_MAX_CHARS"]) assert.match(error.message, new RegExp(key));
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

test("validates PostgreSQL settings without echoing connection details", () => {
  const configuration = validateConfiguration(validValues);
  assert.equal(configuration.agentInstanceId, "agent-inoai-planner");
  assert.equal(configuration.postgresIsolationMode, "application");
  assert.equal(configuration.postgresPoolMax, 2);
  assert.equal(configuration.postgresConnectTimeoutMs, 5000);
  assert.equal(configuration.postgresQueryTimeoutMs, 30000);
  assert.equal(configuration.postgresLeaseTtlMs, 30000);
  assert.equal(configuration.postgresLeaseRefreshMs, 10000);

  for (const value of ["postgres://", "https://user:secret@example.test/db", "postgresql://[invalid"]) {
    assert.throws(() => validateConfiguration({ ...validValues, POSTGRES_URL: value }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, /POSTGRES_URL must be a valid PostgreSQL URL/);
      assert.doesNotMatch(error.message, /secret|example\.test/);
      return true;
    });
  }
});

test("defaults isolation to application and rejects unsupported database enforcement", () => {
  const { POSTGRES_ISOLATION_MODE: _ignored, ...withoutMode } = validValues;
  assert.equal(validateConfiguration(withoutMode).postgresIsolationMode, "application");
  assert.throws(() => validateConfiguration({ ...validValues, POSTGRES_ISOLATION_MODE: "database" }), (error: unknown) => {
    assert(error instanceof ConfigurationError);
    assert.match(error.message, /POSTGRES_ISOLATION_MODE must be application/);
    return true;
  });
});

test("enforces the normalized Agent Instance slug and bounded pool settings", () => {
  for (const value of ["agent-Inoai", "inoai-planner", "agent-", "agent_planner", `agent-${"a".repeat(60)}`]) {
    assert.throws(() => validateConfiguration({ ...validValues, AGENT_INSTANCE_ID: value }), ConfigurationError);
  }
  for (const [key, value] of [["POSTGRES_POOL_MAX", "0"], ["POSTGRES_POOL_MAX", "11"], ["POSTGRES_CONNECT_TIMEOUT_MS", "999"], ["POSTGRES_QUERY_TIMEOUT_MS", "120001"], ["POSTGRES_LEASE_TTL_MS", "4999"], ["POSTGRES_LEASE_REFRESH_MS", "30000"]]) {
    assert.throws(() => validateConfiguration({ ...validValues, [key]: value }), (error: unknown) => {
      assert(error instanceof ConfigurationError);
      assert.match(error.message, new RegExp(key));
      return true;
    });
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
