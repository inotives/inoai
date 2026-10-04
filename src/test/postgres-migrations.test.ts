import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import { discoverMigrations, runMigrations } from "../postgres-migrations.js";

const repositoryRoot = join(import.meta.dirname, "../..");

test("discovers numbered migrations in deterministic order and ignores other files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-migrations-"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "0002_second.sql"), "SELECT 2;\n");
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
  await writeFile(join(directory, "README.md"), "not a migration\n");
  const migrations = await discoverMigrations(directory);
  assert.deepEqual(migrations.map((migration) => migration.version), ["0001", "0002"]);
  assert.notEqual(migrations[0]?.checksum, migrations[1]?.checksum);
});

test("rejects duplicate migration versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-migrations-"));
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
  await writeFile(join(directory, "0001_second.sql"), "SELECT 2;\n");
  await assert.rejects(() => discoverMigrations(directory), /Duplicate migration version: 0001/);
});

test("adds an inferable PostgreSQL conflict target for archived messages", async () => {
  const sql = await readFile(join(repositoryRoot, "migrations", "0005_message_idempotency_conflict_target.sql"), "utf8");
  assert.match(sql, /RENAME TO provision_agent_schema_base/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS unique_external_message_conflict_target/);
  assert.match(sql, /ON %I\.messages \(transport, workspace_id, external_message_id\)/);
  assert.match(sql, /to_regclass\(format\('%I\.messages', n\.nspname\)\)/);
});

test("serializes migration runners with a transaction-scoped advisory lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-migrations-"));
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");

  const queries: string[] = [];
  const client = {
    async query<T = unknown>(sql: string): Promise<{ rows: T[] }> {
      queries.push(sql);
      if (sql.includes("SELECT checksum FROM public.schema_migrations")) return { rows: [] };
      return { rows: [] };
    },
    release(): void {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;

  assert.deepEqual(await runMigrations(pool, directory), ["0001"]);
  assert.equal(queries[0], "BEGIN");
  assert.match(queries[1] ?? "", /pg_advisory_xact_lock/);
  assert.ok(queries.indexOf("COMMIT") > 1);
});
