import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  acquireRuntimeHomeLock,
  bootstrapRuntimeHome,
  InvalidRuntimeHomeError,
  RuntimeHomeLockedError,
  UnsafeRuntimeHomeError,
} from "../runtime-home.js";
import { start } from "../index.js";
import { openDatabase } from "../database.js";
import { sqliteStore } from "./sqlite-store.js";

async function temporaryDeployment(): Promise<string> {
  return mkdtemp(join(tmpdir(), "inoai-test-"));
}

const validEnv = [
  "DISCORD_BOT_TOKEN=token",
  "DISCORD_GUILD_ID=guild",
  "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=channel",
  "CHAT_PROVIDER=discord",
  "AGENT_PROVIDER=codex",
  "POSTGRES_URL=postgresql://inoai_sync:secret@example.test:5432/app",
  "AGENT_INSTANCE_ID=agent-test",
  "MEMORY_REVIEW_TIME=06:00",
  "MEMORY_REVIEW_MAX_CHARS=20000",
].join("\n");

test("bootstraps and preserves an isolated default runtime home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await Promise.all([home.envFile, home.agentFile].map((file) => readFile(file)));
    await assert.rejects(stat(home.databaseFile));
    assert.equal(await readFile(home.envFile, "utf8"), "");
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

test("startup bootstraps and locks the default runtime home", async () => {
  const deployment = await temporaryDeployment();
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await writeFile(home.envFile, validEnv);
    const database = openDatabase(home);
    const instance = await start(deployment, undefined, () => sqliteStore(database));
    try {
      assert.equal(instance.runtimeHome.directory, join(deployment, ".inoai-connect"));
      await assert.rejects(start(deployment), RuntimeHomeLockedError);
    } finally {
      await instance.release();
      database.close();
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
  const executable = fileURLToPath(new URL("../index.js", import.meta.url));
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
