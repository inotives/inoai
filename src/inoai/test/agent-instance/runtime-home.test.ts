import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  acquireRuntimeHomeLock,
  bootstrapRuntimeHome,
  getMacProcessStartTime,
  InvalidRuntimeHomeError,
  RuntimeHomeLockedError,
  UnsafeRuntimeHomeError,
} from "../../agent-instance/runtime-home.js";
import { defaultAgentProfile } from "../../agent-instance/profile.js";
import { start } from "../../../index.js";
import { openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import { manageMemory, manageAllowlist } from "../../app.js";

async function temporaryDeployment(): Promise<string> {
  return mkdtemp(join(tmpdir(), "inoai-test-"));
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

async function startRuntimeLockHolder(deployment: string, connectDirectory: string): Promise<{ child: ReturnType<typeof spawn>; lockContents: string; stop: () => Promise<void> }> {
  const runtimeHomeModule = new URL("../../agent-instance/runtime-home.js", import.meta.url).href;
  const script = `
    import { acquireRuntimeHomeLock, resolveRuntimeHome } from ${JSON.stringify(runtimeHomeModule)};
    const home = resolveRuntimeHome(process.env.TEST_DEPLOYMENT, process.env.TEST_CONNECT_DIRECTORY);
    const release = await acquireRuntimeHomeLock(home);
    process.stdout.write(await (await import('node:fs/promises')).readFile(home.lockFile, 'utf8'));
    process.stdout.write('\\n');
    process.stdin.once('data', async () => { await release(); process.exit(0); });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TEST_DEPLOYMENT: deployment, TEST_CONNECT_DIRECTORY: connectDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const [lockContents] = await Promise.race([
      once(lines, "line") as Promise<[string]>,
      once(child, "exit").then(([code, signal]) => { throw new Error(`Lock holder exited before acquiring lock (${code ?? signal})`); }),
    ]);
    return {
      child,
      lockContents,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) {
          lines.close();
          return;
        }
        child.stdin.end("release");
        const exited = await Promise.race([
          waitForExit(child).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
        ]);
        if (!exited) {
          child.kill("SIGTERM");
          const terminated = await Promise.race([
            waitForExit(child).then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
          ]);
          if (!terminated) {
            child.kill("SIGKILL");
            await waitForExit(child);
          }
        }
        lines.close();
      },
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child);
    lines.close();
    throw error;
  }
}

function runCli(deployment: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = fileURLToPath(new URL("../../../index.js", import.meta.url));
  const child = spawn(process.execPath, [executable, ...args], { cwd: deployment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return once(child, "close").then(([code]) => ({ code: code as number | null, stdout, stderr }));
}

const validEnv = [
  "DISCORD_BOT_TOKEN=token",
  "DISCORD_GUILD_ID=guild",
  "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=channel",
  "CHAT_PROVIDER=discord",
  "AGENT_PROVIDER=codex",
  "AGENT_INSTANCE_ID=agent-test",
  "MEMORY_REVIEW_TIME=06:00",
  "MEMORY_REVIEW_MAX_CHARS=20000",
].join("\n");

test("bootstraps and preserves an isolated default runtime home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await Promise.all([home.envFile, home.agentFile, home.skillsEnabledFile].map((file) => readFile(file)));
    await assert.rejects(stat(home.databaseFile));
    assert.equal(await readFile(home.envFile, "utf8"), "");
    assert.equal(await readFile(home.agentFile, "utf8"), defaultAgentProfile);
    assert.deepEqual(JSON.parse(await readFile(home.skillsEnabledFile, "utf8")), { version: 1, skills: [] });
    assert.equal((await stat(home.skillsDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(home.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(home.envFile)).mode & 0o777, 0o600);

    await writeFile(home.envFile, "OWNER_DISCORD_USER_ID=owner\n");
    await bootstrapRuntimeHome(deployment);
    assert.equal(await readFile(home.envFile, "utf8"), "OWNER_DISCORD_USER_ID=owner\n");
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("rejects runtime homes outside the deployment folder", async () => {
  await assert.rejects(bootstrapRuntimeHome("/tmp", ".inoai-connect/child"), InvalidRuntimeHomeError);
  await assert.rejects(bootstrapRuntimeHome("/tmp", "../.inoai-connect"), InvalidRuntimeHomeError);
  await assert.rejects(bootstrapRuntimeHome("/tmp", "/tmp/.inoai-connect"), InvalidRuntimeHomeError);
});

test("accepts a Robin test runtime home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment, ".robin-xai-test");
    assert.equal(home.directory, join(deployment, ".robin-xai-test"));
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("rejects a runtime-home symlink", async () => {
  const deployment = await temporaryDeployment();
  const outside = await temporaryDeployment();
  try {
    await symlink(outside, join(deployment, ".inoai-connect"));
    await assert.rejects(bootstrapRuntimeHome(deployment), UnsafeRuntimeHomeError);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("locks one runtime home while allowing an alternate home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const primary = await bootstrapRuntimeHome(deployment);
    const releasePrimary = await acquireRuntimeHomeLock(primary);
    try {
      await assert.rejects(acquireRuntimeHomeLock(primary), RuntimeHomeLockedError);

      const alternate = await bootstrapRuntimeHome(deployment, ".inoai-connect-2");
      const releaseAlternate = await acquireRuntimeHomeLock(alternate);
      await releaseAlternate();
    } finally {
      await releasePrimary();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("writes a process-identifying JSON lock record", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const release = await acquireRuntimeHomeLock(home);
    try {
      const record = JSON.parse(await readFile(home.lockFile, "utf8")) as { pid: number; started_at: string; token: string };
      assert.equal(record.pid, process.pid);
      assert.equal(typeof record.started_at, "string");
      assert.ok(record.started_at.length > 0);
      assert.match(record.token, /^[0-9a-f-]{36}$/);
      const currentStart = await getMacProcessStartTime(process.pid);
      assert.equal(currentStart !== undefined, process.platform === "darwin");
      if (currentStart !== undefined) assert.equal(record.started_at, currentStart);
    } finally {
      await release();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("legacy or malformed lock contents are not released", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const release = await acquireRuntimeHomeLock(home);
    await writeFile(home.lockFile, "legacy-token");
    await release();
    assert.equal(await readFile(home.lockFile, "utf8"), "legacy-token");

    await writeFile(home.lockFile, "not-json");
    const releaseAgain = await acquireRuntimeHomeLock(home).catch(() => undefined);
    assert.equal(releaseAgain, undefined);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("reclaims a lock whose recorded process has exited", { skip: process.platform !== "darwin" }, async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const childPid = child.pid;
    assert.ok(childPid);
    await once(child, "exit");
    await writeFile(home.lockFile, JSON.stringify({
      pid: childPid,
      started_at: "stopped-process",
      token: "dead-owner-token",
    }));

    const release = await acquireRuntimeHomeLock(home);
    try {
      const record = JSON.parse(await readFile(home.lockFile, "utf8")) as { pid: number };
      assert.equal(record.pid, process.pid);
    } finally {
      await release();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("reclaims a lock when the PID start time does not match", { skip: process.platform !== "darwin" }, async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await writeFile(home.lockFile, JSON.stringify({
      pid: process.pid,
      started_at: "different-process-start",
      token: "reused-pid-token",
    }));

    const release = await acquireRuntimeHomeLock(home);
    await release();
    await assert.rejects(readFile(home.lockFile, "utf8"));
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("startup bootstraps and locks the default runtime home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await writeFile(home.envFile, validEnv);
    const instance = await start(deployment);
    try {
      assert.equal(instance.runtimeHome.directory, join(deployment, ".inoai-connect"));
      await assert.rejects(start(deployment), RuntimeHomeLockedError);
    } finally {
      await instance.release();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("a stale release cannot remove a successor lock", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const releaseOriginal = await acquireRuntimeHomeLock(home);
    await rm(home.lockFile);
    const releaseSuccessor = await acquireRuntimeHomeLock(home);
    try {
      await releaseOriginal();
      await assert.rejects(acquireRuntimeHomeLock(home), RuntimeHomeLockedError);
    } finally {
      await releaseSuccessor();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("concurrent releases cannot remove a successor lock", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const releaseOriginal = await acquireRuntimeHomeLock(home);
    await rm(home.lockFile);
    const releaseSuccessor = await acquireRuntimeHomeLock(home);
    try {
      await Promise.all([releaseOriginal(), releaseOriginal()]);
      await assert.rejects(acquireRuntimeHomeLock(home), RuntimeHomeLockedError);
    } finally {
      await releaseSuccessor();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("the executable validates --connect-dir without connecting", async () => {
  const deployment = await temporaryDeployment();
  const executable = fileURLToPath(new URL("../../../index.js", import.meta.url));
  const home = await bootstrapRuntimeHome(deployment, ".inoai-connect-2");
  await writeFile(home.envFile, validEnv);
  const child = spawn(process.execPath, [executable, "validate", "--connect-dir", ".inoai-connect-2"], { cwd: deployment });
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    await assert.rejects(stat(join(deployment, ".inoai-connect-2", "inoai.lock")));
    await assert.rejects(stat(join(deployment, ".inoai-connect", "inoai.lock")));
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("the executable validates the runtime-home agent profile offline", async () => {
  const deployment = await temporaryDeployment();
  const executable = fileURLToPath(new URL("../../../index.js", import.meta.url));
  const home = await bootstrapRuntimeHome(deployment, ".inoai-connect-profile");
  await writeFile(home.envFile, validEnv);
  const child = spawn(process.execPath, [executable, "profile", "validate", "--connect-dir", ".inoai-connect-profile"], { cwd: deployment });
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("SQLite startup reuses sessions and Memory and closes its handle on shutdown", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await writeFile(home.envFile, validEnv + "\nPOSTGRES_URL=invalid-unused-value\nPOSTGRES_POOL_MAX=invalid");
    const first = await start(deployment);
    const session = await first.store.createSession({
      user_id: first.owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread",
      initiating_external_message_id: "message", agent_provider: "codex",
      agent_session_id: "persisted-session", project_path: deployment,
    }, "test");
    const message = await first.store.archiveMessage({
      session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "queued",
      external_author_id: "owner", user_id: first.owner.id, direction: "user", body: "Recover this turn",
      reply_to_external_message_id: null, in_reply_to_message_id: null,
    }, "test");
    assert(message.message);
    assert.equal((await first.store.claimNextMessage("global", "test"))?.id, message.message.id);
    const memory = await first.store.createMemory({ body: "Persistent fact", origin: "manual",
      created_by_user_id: first.owner.id, source_message_id: null, review_id: null }, "test");
    assert.equal("pool" in first, false);
    assert.equal("lease" in first, false);
    const reader = openDatabase(home);
    assert.equal(reader.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    reader.close();
    await first.release();
    await first.release();
    await assert.rejects(first.store.listSessions(), /closed|not open/i);
    const second = await start(deployment);
    try {
      assert.equal((await second.store.getSession(session.id))?.agent_session_id, "persisted-session");
      assert.equal((await second.store.listMemories())[0]?.id, memory.id);
      assert.equal(second.owner.id, first.owner.id);
      assert.equal((await second.store.listMessages(session.id))[0]?.state, "pending");
    } finally {
      await second.release();
    }
    const added = await manageMemory("add", "CLI fact", deployment);
    assert.equal((await manageMemory("list", undefined, deployment)).length, 2);
    await manageMemory("delete", String(added.id), deployment);
    assert.equal((await manageMemory("list", undefined, deployment)).length, 1);
    assert.equal((await manageAllowlist("add", "123", "Family", deployment)).state, "active");
    assert.equal((await manageAllowlist("disable", "123", undefined, deployment)).state, "disabled");
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("allowlist CLI adds and disables users while a separate runtime process holds the lock", async () => {
  const deployment = await temporaryDeployment();
  const connectDirectory = ".robin-xai-test";
  const ownerId = "111111111111111111";
  const familyUserId = "222222222222222222";
  let lockHolder: Awaited<ReturnType<typeof startRuntimeLockHolder>> | undefined;
  try {
    const home = await bootstrapRuntimeHome(deployment, connectDirectory);
    await writeFile(home.envFile, validEnv.replace("DISCORD_OWNER_USER_ID=owner", `DISCORD_OWNER_USER_ID=${ownerId}`));
    const instance = await start(deployment, connectDirectory);
    await instance.release();

    lockHolder = await startRuntimeLockHolder(deployment, connectDirectory);
    const add = await runCli(deployment, ["allowlist:add", "--user-id", familyUserId, "--display-name", "Family Name", "--connect-dir", connectDirectory]);
    assert.equal(add.code, 0, add.stderr);
    assert.deepEqual(JSON.parse(add.stdout), { action: "add", user_id: familyUserId, guild_id: "guild", role: "family", state: "active" });

    const database = new DatabaseSync(home.databaseFile);
    try {
      const active = database.prepare("SELECT * FROM users WHERE transport='discord' AND workspace_id='guild' AND external_user_id=?").get(familyUserId) as {
        role: string; state: string; created_by: string; updated_by: string; deleted_at: number | null; deleted_by: string | null;
      };
      assert.equal(active.role, "family");
      assert.equal(active.state, "active");
      assert.equal(active.created_by, "allowlist-cli");
      assert.equal(active.updated_by, "allowlist-cli");
      assert.equal(active.deleted_at, null);
      assert.equal(active.deleted_by, null);
    } finally {
      database.close();
    }

    const disable = await runCli(deployment, ["allowlist:disable", "--user-id", familyUserId, "--connect-dir", connectDirectory]);
    assert.equal(disable.code, 0, disable.stderr);
    assert.deepEqual(JSON.parse(disable.stdout), { action: "disable", user_id: familyUserId, guild_id: "guild", role: "family", state: "disabled" });

    const verification = new DatabaseSync(home.databaseFile);
    try {
      const disabled = verification.prepare("SELECT state, created_by, updated_by, deleted_at, deleted_by FROM users WHERE transport='discord' AND workspace_id='guild' AND external_user_id=?").get(familyUserId) as {
        state: string; created_by: string; updated_by: string; deleted_at: number | null; deleted_by: string | null;
      };
      assert.equal(disabled.state, "disabled");
      assert.equal(disabled.created_by, "allowlist-cli");
      assert.equal(disabled.updated_by, "allowlist-cli");
      assert.equal(disabled.deleted_at, null);
      assert.equal(disabled.deleted_by, null);
    } finally {
      verification.close();
    }

    assert.equal(await readFile(home.lockFile, "utf8"), `${lockHolder.lockContents}\n`);

    const invalidUserId = "333333333333333333";
    const invalid = await runCli(deployment, ["allowlist:add", "--user-id", invalidUserId, "--display-name", "   ", "--connect-dir", connectDirectory]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /--display-name must be between 1 and 256 characters/);
    assert.doesNotMatch(invalid.stderr, new RegExp(`${invalidUserId}|guild`));

    const owner = await runCli(deployment, ["allowlist:disable", "--user-id", ownerId, "--connect-dir", connectDirectory]);
    assert.equal(owner.code, 1);
    assert.match(owner.stderr, /configured Discord owner cannot be changed/);
    assert.doesNotMatch(owner.stderr, new RegExp(`${ownerId}|guild`));
    assert.equal(await readFile(home.lockFile, "utf8"), `${lockHolder.lockContents}\n`);
  } finally {
    await lockHolder?.stop();
    await rm(deployment, { recursive: true, force: true });
  }
});

test("allowlist CLI reports SQLite busy as retryable without partial writes or identifiers", async () => {
  const deployment = await temporaryDeployment();
  const connectDirectory = ".robin-xai-test";
  const targetUserId = "444444444444444444";
  let lockHolder: Awaited<ReturnType<typeof startRuntimeLockHolder>> | undefined;
  let database: DatabaseSync | undefined;
  try {
    const home = await bootstrapRuntimeHome(deployment, connectDirectory);
    await writeFile(home.envFile, validEnv);
    const instance = await start(deployment, connectDirectory);
    await instance.release();
    lockHolder = await startRuntimeLockHolder(deployment, connectDirectory);
    database = new DatabaseSync(home.databaseFile);
    database.exec("BEGIN IMMEDIATE");

    const result = await runCli(deployment, ["allowlist:add", "--user-id", targetUserId, "--display-name", "Busy User", "--connect-dir", connectDirectory]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /SQLite database is busy\. Retry the allowlist command shortly\./);
    assert.doesNotMatch(result.stderr, new RegExp(`${targetUserId}|guild`));

    database.exec("ROLLBACK");
    const row = database.prepare("SELECT 1 FROM users WHERE transport='discord' AND workspace_id='guild' AND external_user_id=?").get(targetUserId);
    assert.equal(row, undefined);
    assert.equal(await readFile(home.lockFile, "utf8"), `${lockHolder.lockContents}\n`);
  } finally {
    if (database?.isTransaction) database.exec("ROLLBACK");
    database?.close();
    await lockHolder?.stop();
    await rm(deployment, { recursive: true, force: true });
  }
});
