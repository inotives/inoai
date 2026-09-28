import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase, upsertUser } from "../database.js";
import { manageMemory } from "../index.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

const execFile = promisify(execFileCallback);

test("Manual Memory CLI persists, lists, and soft-deletes without runtime startup", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    const owner = upsertUser(database, {
      transport: "discord",
      workspace_id: "workspace",
      external_user_id: "owner",
      display_name: "Owner",
      role: "owner",
      state: "active",
    }, "owner-bootstrap")!;
    database.close();

    const created = await manageMemory("add", "remember this", deployment);
    assert.equal(created.origin, "manual");
    assert.equal(created.created_by_user_id, owner.id);
    assert.equal(created.created_by, `manual-cli:user:${owner.id}`);
    assert.deepEqual((await manageMemory("list", undefined, deployment)).map((memory) => memory.id), [created.id]);

    await manageMemory("delete", String(created.id), deployment);
    assert.deepEqual(await manageMemory("list", undefined, deployment), []);

    const reopened = openDatabase(home);
    const deleted = reopened.prepare("SELECT origin, state, deleted_at, deleted_by FROM memories WHERE id = ?").get(created.id) as {
      origin: string;
      state: string;
      deleted_at: number;
      deleted_by: string;
    };
    assert.deepEqual(deleted.origin, "manual");
    assert.equal(deleted.state, "deleted");
    assert.ok(deleted.deleted_at);
    assert.equal(deleted.deleted_by, `manual-cli:user:${owner.id}`);
    reopened.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("memory subcommands work with a blank runtime configuration", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  const executable = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    const created = JSON.parse((await execFile(process.execPath, [executable, "memory", "add", "offline memory"], { cwd: deployment })).stdout);
    const listed = JSON.parse((await execFile(process.execPath, [executable, "memory", "list"], { cwd: deployment })).stdout);
    await execFile(process.execPath, [executable, "memory", "delete", String(created.id)], { cwd: deployment });
    assert.equal(created.origin, "manual");
    assert.equal(created.created_by_user_id, null);
    assert.deepEqual(listed.map((memory: { id: number }) => memory.id), [created.id]);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});
