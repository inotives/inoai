import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

export type Migration = {
  version: string;
  path: string;
  sql: string;
  checksum: string;
};

const migrationLockName = "inoai.schema_migrations";

const migrationName = /^(\d{4,})_([a-z0-9][a-z0-9_-]*)\.sql$/;

export async function discoverMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && migrationName.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const migrations: Migration[] = [];
  const seenVersions = new Set<string>();
  for (const file of files) {
    const match = migrationName.exec(file);
    if (!match) continue;
    const version = match[1];
    if (seenVersions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    seenVersions.add(version);
    const path = resolve(directory, file);
    const sql = await readFile(path, "utf8");
    migrations.push({ version, path, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

async function ensureTrackingTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(pool: Pool, directory: string): Promise<string[]> {
  const migrations = await discoverMigrations(directory);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationLockName]);
    await ensureTrackingTable(client);
    for (const migration of migrations) {
      const result = await client.query<{ checksum: string }>(
        "SELECT checksum FROM public.schema_migrations WHERE version = $1",
        [migration.version],
      );
      const existing = result.rows[0];
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Migration checksum changed: ${migration.version}`);
        }
        continue;
      }
      if (migration.sql.trim()) await client.query(migration.sql);
      await client.query(
        "INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function usage(): never {
  console.error("Usage: npm run postgres:migrate -- --url <admin-postgres-url> [--migrations-dir <path>]");
  process.exit(2);
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const url = argumentValue(args, "--url");
  if (!url || url.startsWith("--")) usage();
  const configuredDirectory = argumentValue(args, "--migrations-dir");
  if (configuredDirectory?.startsWith("--")) usage();
  const directory = resolve(configuredDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../migrations"));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const applied = await runMigrations(pool, directory);
    console.log(applied.length > 0 ? `Applied ${applied.length} migration(s).` : "Migrations are up to date.");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    console.error("PostgreSQL migrations failed.");
    process.exitCode = 1;
  });
}
