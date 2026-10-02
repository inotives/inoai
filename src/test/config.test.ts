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
    for (const key of Object.keys(validValues)) assert.match(error.message, new RegExp(key));
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
  assert.throws(() => validateConfiguration({ ...validValues, AGENT_PROVIDER: "opencode" }), (error: unknown) => {
    assert(error instanceof ConfigurationError);
    assert.match(error.message, /AGENT_PROVIDER must be codex or claude/);
    return true;
  });
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
