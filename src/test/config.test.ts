import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError, loadConfiguration, validateConfiguration } from "../config.js";
import type { BigQueryUpsertRequest } from "../bigquery.js";
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

test("accepts an optional non-secret Agent Instance name and rejects unsafe values", () => {
  assert.equal(validateConfiguration({ ...validValues, AGENT_NAME: " planner " }).agentName, "planner");
  assert.equal(validateConfiguration({ ...validValues, AGENT_NAME: "" }).agentName, undefined);
  assert.throws(() => validateConfiguration({ ...validValues, AGENT_NAME: "bad\nname" }), ConfigurationError);
  assert.throws(() => validateConfiguration({ ...validValues, AGENT_NAME: "x".repeat(101) }), ConfigurationError);
});

test("normal startup persists the configured Agent Instance name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, Object.entries({ ...validValues, AGENT_NAME: "planner" }).map(([key, value]) => `${key}=${value}`).join("\n"));
    const instance = await start(directory);
    assert.equal(instance.configuration.agentName, "planner");
    assert.equal((instance.database.prepare("SELECT agent_name FROM agent_instance_metadata WHERE id = 1").get() as { agent_name: string }).agent_name, "planner");
    await instance.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured BigQuery sync is wired into startup and release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, Object.entries({ ...validValues,
      BIGQUERY_PROJECT_ID: "inoai-agents", BIGQUERY_DATASET_ID: "inoai_analytics", BIGQUERY_SYNC_INTERVAL_MINUTES: "60",
    }).map(([key, value]) => `${key}=${value}`).join("\n"));
    const calls: BigQueryUpsertRequest[] = [];
    let cleared = false;
    const instance = await start(directory, undefined, {
      bigQueryClient: { upsertRows: async (request) => { calls.push(request); } },
      bigQueryClock: {
        now: () => new Date(2_000_000_000_000),
        setInterval: (callback) => callback,
        clearInterval: () => { cleared = true; },
      },
    });
    instance.bigQueryScheduler.start();
    await instance.release();
    assert.equal(instance.configuration.bigQuery?.projectId, "inoai-agents");
    assert.equal(calls.length, 1);
    assert.equal(cleared, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores CLAUDE_MODEL for a Codex home", () => {
  const configuration = validateConfiguration({ ...validValues, CLAUDE_MODEL: "opus 4" });
  assert.equal(configuration.agentProvider, "codex");
  assert.equal(configuration.claudeModel, undefined);
});

test("keeps BigQuery disabled by default and parses optional settings", () => {
  const disabled = validateConfiguration(validValues);
  assert.equal(disabled.bigQuery, undefined);
  assert.equal(disabled.bigQueryIssue, undefined);
  const enabled = validateConfiguration({
    ...validValues,
    BIGQUERY_PROJECT_ID: "inoai-prod-123",
    BIGQUERY_DATASET_ID: "analytics",
    BIGQUERY_SYNC_INTERVAL_MINUTES: "15",
  });
  assert.deepEqual(enabled.bigQuery, { projectId: "inoai-prod-123", datasetId: "analytics", syncIntervalMinutes: 15 });
});

test("keeps the copied sample configuration cleanly disabled", async () => {
  const optionalValues = Object.fromEntries(
    (await readFile(new URL("../../.env.sample", import.meta.url), "utf8"))
      .split(/\r?\n/)
      .filter((line) => /^(BIGQUERY_PROJECT_ID|BIGQUERY_DATASET_ID|BIGQUERY_SYNC_INTERVAL_MINUTES)=/.test(line))
      .map((line) => line.split("=", 2) as [string, string]),
  );
  const configuration = validateConfiguration({ ...validValues, ...optionalValues });
  assert.equal(configuration.bigQuery, undefined);
  assert.equal(configuration.bigQueryIssue, undefined);
});

test("disables only the optional BigQuery path for invalid settings without exposing values", () => {
  const configuration = validateConfiguration({
    ...validValues,
    BIGQUERY_PROJECT_ID: "bad project secret-token",
    BIGQUERY_DATASET_ID: "bad.dataset",
    BIGQUERY_SYNC_INTERVAL_MINUTES: "0",
  });
  assert.equal(configuration.bigQuery, undefined);
  assert.match(configuration.bigQueryIssue ?? "", /BigQuery sync disabled: invalid project id, dataset id, sync interval/);
  assert.doesNotMatch(configuration.bigQueryIssue ?? "", /secret-token|bad project/);
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
