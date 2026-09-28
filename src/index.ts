import { pathToFileURL } from "node:url";

import { loadConfiguration } from "./config.js";
import { bootstrapOwner, createMemory, listMemories, openDatabase, softDeleteMemory } from "./database.js";
import type { MemoryRecord } from "./database.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "./runtime-home.js";
import { launchUi } from "./ui.js";

export const appName = "inoai";
export * from "./config.js";
export * from "./database.js";
export * from "./runtime-home.js";
export * from "./ui.js";

export async function validate(launchDirectory = process.cwd(), connectDirectory?: string) {
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const configuration = await loadConfiguration(runtimeHome.envFile);
  return { runtimeHome, configuration };
}

export async function start(launchDirectory = process.cwd(), connectDirectory?: string) {
  const { runtimeHome, configuration } = await validate(launchDirectory, connectDirectory);
  const release = await acquireRuntimeHomeLock(runtimeHome);
  try {
    const database = openDatabase(runtimeHome);
    const owner = bootstrapOwner(database, configuration);
    return {
      runtimeHome,
      configuration,
      database,
      owner,
      release: async () => {
        database.close();
        await release();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export function manageMemory(operation: "add", argument: string, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord>;
export function manageMemory(operation: "list", argument: undefined, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord[]>;
export function manageMemory(operation: "delete", argument: string, launchDirectory?: string, connectDirectory?: string): Promise<void>;
export function manageMemory(operation: "add" | "list" | "delete", argument: string | undefined, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord | MemoryRecord[] | void>;
export async function manageMemory(
  operation: "add" | "list" | "delete",
  argument: string | undefined,
  launchDirectory = process.cwd(),
  connectDirectory?: string,
): Promise<MemoryRecord | MemoryRecord[] | void> {
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const database = openDatabase(runtimeHome);
  try {
    const owner = database.prepare("SELECT id FROM users WHERE role = 'owner' AND state = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    const actor = owner ? `manual-cli:user:${owner.id}` : "manual-cli";
    if (operation === "list") return listMemories(database);
    if (operation === "add") {
      const body = argument?.trim();
      if (!body) throw new Error("Usage: inoai memory add <text>");
      return createMemory(database, {
        body,
        source_message_id: null,
        created_by_user_id: owner?.id ?? null,
        review_id: null,
        origin: "manual",
      }, actor);
    }
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Usage: inoai memory delete <id>");
    if (!listMemories(database).some((memory) => memory.id === id)) throw new Error(`Manual Memory Entry not found: ${id}`);
    softDeleteMemory(database, id, actor);
  } finally {
    database.close();
  }
}

export function parseConnectDirectory(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--connect-dir") return args[1];
  throw new Error("Usage: inoai [--connect-dir .inoai-connect*]");
}

function parseMemoryCommand(args: string[]): { operation: "add" | "list" | "delete"; argument: string | undefined; connectDirectory: string | undefined } {
  const connectDirectory = args.length >= 2 && args.at(-2) === "--connect-dir" ? args.at(-1) : undefined;
  const command = connectDirectory === undefined ? args : args.slice(0, -2);
  const [operation, ...values] = command;
  if ((operation === "add" || operation === "delete") && values.length === 1) return { operation, argument: values[0], connectDirectory };
  if (operation === "list" && values.length === 0) return { operation, argument: undefined, connectDirectory };
  throw new Error("Usage: inoai memory <add <text>|list|delete <id>> [--connect-dir .inoai-connect*]");
}

async function run(args: string[]): Promise<void> {
  if (args[0] === "memory") {
    const { operation, argument, connectDirectory } = parseMemoryCommand(args.slice(1));
    const result = await manageMemory(operation, argument, process.cwd(), connectDirectory);
    console.log(JSON.stringify(result));
    return;
  }
  if (args[0] === "ui") {
    await launchUi(process.cwd(), parseConnectDirectory(args.slice(1)));
    return;
  }
  if (args[0] === "validate") {
    const { runtimeHome } = await validate(process.cwd(), parseConnectDirectory(args.slice(1)));
    console.log(`inoai configuration is valid: ${runtimeHome.directory}`);
    return;
  }
  const { runtimeHome, release } = await start(process.cwd(), parseConnectDirectory(args));
  const keepAlive = setInterval(() => undefined, 2 ** 31 - 1);
  const stop = () => void release().finally(() => {
    clearInterval(keepAlive);
    process.exit(0);
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`inoai started with ${runtimeHome.directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
