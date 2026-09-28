import { pathToFileURL } from "node:url";

import { loadConfiguration } from "./config.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "./runtime-home.js";
import { launchUi } from "./ui.js";

export const appName = "inoai";
export * from "./config.js";
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
  return { runtimeHome, configuration, release };
}

export function parseConnectDirectory(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--connect-dir") return args[1];
  throw new Error("Usage: inoai [--connect-dir .inoai-connect*]");
}

async function run(args: string[]): Promise<void> {
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
