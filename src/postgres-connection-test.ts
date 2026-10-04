import { readFile } from "node:fs/promises";
import { Client } from "pg";

function runtimeDirectory(args: string[]): string {
  const index = args.indexOf("--connect-dir");
  return index >= 0 && args[index + 1] ? args[index + 1] : ".inoai-connect-planner";
}

function parseDotEnv(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*POSTGRES_URL\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[1].trim();
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  }
  return undefined;
}

const directory = runtimeDirectory(process.argv.slice(2));
const connectionString = parseDotEnv(await readFile(`${directory}/.env`, "utf8"));
if (!connectionString) {
  console.error(`POSTGRES_URL is missing from ${directory}/.env`);
  process.exitCode = 1;
} else {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await client.query<{ database: string; user: string }>("SELECT current_database() AS database, current_user AS user");
    console.log(`PostgreSQL connection succeeded: database=${result.rows[0]?.database ?? "unknown"}; user=${result.rows[0]?.user ?? "unknown"}`);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    console.error(`PostgreSQL connection failed (code=${code}). Check the runtime URL, network access, TLS, and credentials.`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}
