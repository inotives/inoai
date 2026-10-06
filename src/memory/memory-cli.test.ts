import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase, upsertUser } from "../database.js";
import { manageMemory, manageMemoryWithStore } from "../index.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

const execFile = promisify(execFileCallback);

test("Manual Memory operations use the injected operational store without runtime startup", async () => {
  const memories: any[] = [];
  const store = {
    async listMemories() { return memories.filter((memory) => memory.state === "active"); },
    async createMemory(memory: any, actor?: string) { const row = { ...memory, id: 1, state: "active", created_by: actor, updated_by: actor, deleted_at: null, deleted_by: null }; memories.push(row); return row; },
    async softDeleteMemory(id: number, actor?: string) { const row = memories.find((memory) => memory.id === id); if (row) Object.assign(row, { state: "deleted", deleted_by: actor }); },
  };
  const created = await manageMemoryWithStore(store, "add", "remember this", 7) as any;
  assert.equal(created.origin, "manual");
  assert.equal(created.created_by_user_id, 7);
  assert.deepEqual((await manageMemoryWithStore(store, "list", undefined, 7) as any[]).map((memory) => memory.id), [1]);
  await manageMemoryWithStore(store, "delete", "1", 7);
  assert.deepEqual(await manageMemoryWithStore(store, "list", undefined, 7), []);
});

test("memory subcommands require PostgreSQL runtime configuration", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  const executable = fileURLToPath(new URL("../index.js", import.meta.url));
  try {
    await assert.rejects(execFile(process.execPath, [executable, "memory", "add", "offline memory"], { cwd: deployment }), /Invalid configuration/);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("PostgreSQL Manual Memory adapter never starts a runtime and preserves soft-delete actor", async () => {
  let nextId = 7;
  const memories: any[] = [];
  const store = {
    async listMemories() { return memories.filter((memory) => memory.state === "active"); },
    async createMemory(memory: any, actor?: string) {
      const row = { ...memory, id: nextId++, state: "active", created_by: actor, updated_by: actor, deleted_at: null, deleted_by: null };
      memories.push(row);
      return row;
    },
    async softDeleteMemory(id: number, actor?: string) {
      const row = memories.find((memory) => memory.id === id);
      if (row) Object.assign(row, { state: "deleted", deleted_by: actor, updated_by: actor });
    },
  };
  const created = await manageMemoryWithStore(store, "add", "postgres memory", 42) as any;
  assert.equal(created.created_by, "manual-cli:user:42");
  assert.deepEqual((await manageMemoryWithStore(store, "list", undefined, 42) as any[]).map((memory) => memory.id), [7]);
  await manageMemoryWithStore(store, "delete", "7", 42);
  assert.equal(memories[0].state, "deleted");
  assert.equal(memories[0].deleted_by, "manual-cli:user:42");
});
