import { spawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveRuntimeHome } from "./runtime-home.js";

type UiSpawner = (command: string, args: string[], options: SpawnOptions) => { unref(): void };

export async function launchUi(
  launchDirectory: string,
  connectDirectory?: string,
  spawnProcess: UiSpawner = spawn,
): Promise<void> {
  const bundle = resolve(launchDirectory, "inoai-ui.app");
  if (!(await stat(bundle)).isDirectory()) throw new Error(`Sibling UI bundle not found: ${bundle}`);

  const runtimeHome = resolveRuntimeHome(launchDirectory, connectDirectory);
  spawnProcess("open", ["-n", bundle, "--args", "--database", runtimeHome.databaseFile], {
    detached: true,
    stdio: "ignore",
  }).unref();
}
