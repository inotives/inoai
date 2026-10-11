import assert from "node:assert/strict";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { start, validate } from "../app/application.js";
import { HealthPolicy, probeHealth, sqliteHealthProbes } from "../heartbeat/health.js";
import { bootstrapRuntimeHome } from "../platform/runtime-home.js";

const environment = `DISCORD_BOT_TOKEN=acceptance-placeholder
DISCORD_GUILD_ID=guild
DISCORD_OWNER_USER_ID=owner
DISCORD_STATUS_CHANNEL_ID=status
CHAT_PROVIDER=discord
AGENT_PROVIDER=codex
AGENT_INSTANCE_ID=agent-acceptance
MEMORY_REVIEW_TIME=06:00
MEMORY_REVIEW_MAX_CHARS=20000
`;

for (const postgres of ["", "POSTGRES_URL=postgresql://127.0.0.1:1/unavailable\nPOSTGRES_POOL_MAX=invalid\n"]) {
  test(`SQLite runtime starts, permits readers, and reuses durable data ${postgres ? "with unavailable PostgreSQL" : "without PostgreSQL"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "inoai-sqlite-acceptance-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const home = await bootstrapRuntimeHome(directory, ".inoai-connect-acceptance");
    await writeFile(home.envFile, environment + postgres);
    const validated = await validate(directory, ".inoai-connect-acceptance");
    assert.equal(validated.configuration.postgresUrl, undefined);
    assert.equal(await stat(home.databaseFile).then(() => true, () => false), false);

    const first = await start(directory, ".inoai-connect-acceptance");
    t.after(() => first.release());
    const session = await first.store.createSession({
      user_id: first.owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "parent", conversation_id: "thread",
      initiating_external_message_id: "initial", agent_provider: "codex",
      agent_session_id: "runtime-session", project_path: directory,
    }, "acceptance");
    const memory = await first.store.createMemory({
      body: "Use local SQLite.", source_message_id: null, created_by_user_id: first.owner.id,
      review_id: null, origin: "manual",
    }, "acceptance");
    await assert.rejects(start(directory, ".inoai-connect-acceptance"), /already running|locked/i);

    // The local UI and read-only tools can inspect committed data while the core owns the home.
    const reader = new DatabaseSync(home.databaseFile, { readOnly: true });
    try {
      assert.equal(reader.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
      assert.equal(reader.prepare("SELECT agent_session_id FROM sessions WHERE id=?").get(session.id)!.agent_session_id, "runtime-session");
      assert.equal(reader.prepare("SELECT body FROM memories WHERE id=?").get(memory.id)!.body, memory.body);
      await first.store.createEvent({ session_id: session.id, message_id: null, event_type: "acceptance_reader", detail: "reader is open" }, "acceptance");
      assert.equal(reader.prepare("SELECT count(*) AS count FROM events WHERE event_type='acceptance_reader'").get()!.count, 1);
      assert.throws(() => reader.exec("UPDATE memories SET body='forbidden'"), /readonly/i);
      const health = await probeHealth({ childPid: process.pid, lockFile: home.lockFile, ...sqliteHealthProbes(home.databaseFile) });
      assert.deepEqual(health, { child: "alive", lock: "live", query: "healthy" });
    } finally {
      reader.close();
    }
    await first.release();
    const restarted = await start(directory, ".inoai-connect-acceptance");
    try {
      assert.equal(restarted.owner.id, first.owner.id);
      assert.equal((await restarted.store.getSession(session.id))!.agent_session_id, "runtime-session");
      assert.deepEqual(await restarted.store.listMemories(), [memory]);
      assert.equal((await restarted.store.listEvents(session.id)).filter((event) => event.event_type === "acceptance_reader").length, 1);
    } finally {
      await restarted.release();
    }
    assert.equal(await stat(home.lockFile).then(() => true, () => false), false);
  });
}

test("local heartbeat detects SQLite loss and recovers against the reused runtime database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-sqlite-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(directory);
  await writeFile(home.envFile, environment);
  const instance = await start(directory);
  t.after(() => instance.release());
  const check = () => probeHealth({ childPid: process.pid, lockFile: home.lockFile, ...sqliteHealthProbes(home.databaseFile) });
  const policy = new HealthPolicy();
  assert.equal(policy.evaluate(await check()).healthy, true);
  // Hide only this disposable database. A read-only probe must not recreate it.
  await rename(home.databaseFile, `${home.databaseFile}.saved`);
  try {
    assert.equal(policy.evaluate(await check()).action, "none");
    assert.equal(policy.evaluate(await check()).action, "restart");
    assert.equal(await stat(home.databaseFile).then(() => true, () => false), false);
  } finally {
    await rename(`${home.databaseFile}.saved`, home.databaseFile);
  }
  await instance.release();
  const restarted = await start(directory);
  try {
    assert.deepEqual(new HealthPolicy().evaluate(await check()), {
      healthy: true, action: "none", consecutiveDatabaseFailures: 0,
    });
  } finally {
    await restarted.release();
  }
});
