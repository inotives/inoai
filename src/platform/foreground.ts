import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import type { parseUiOptions } from "../ui/common/options.js";

type Options = ReturnType<typeof parseUiOptions>;
type Dependencies = {
  spawnChild(args: string[]): ChildProcess;
  signals: Pick<EventEmitter, "on" | "off">;
  report(message: string): void;
  reportError(message: string): void;
};

export async function startForeground(options: Options, supplied: Partial<Dependencies> = {}): Promise<number> {
  const dependencies: Dependencies = {
    spawnChild: (args) => spawn(process.execPath, [...(isSea() ? [] : [fileURLToPath(new URL("../index.js", import.meta.url))]), ...args], {
      stdio: ["inherit", "inherit", "inherit", "ipc"], shell: false,
    }),
    signals: process,
    report: console.log,
    reportError: console.error,
    ...supplied,
  };
  const homeArgs = options.connectDirectory ? ["--connect-dir", options.connectDirectory] : [];
  const active = new Set<ChildProcess>();
  let stopping = false;
  let exitCode = 0;
  let timeout: NodeJS.Timeout | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });

  const stop = (failure?: string) => {
    if (failure && !stopping) { dependencies.reportError(failure); exitCode = 1; }
    if (stopping) return;
    stopping = true;
    for (const child of active) child.kill("SIGTERM");
    if (active.size === 0) { done(); return; }
    timeout = setTimeout(() => { for (const child of active) child.kill("SIGKILL"); }, 10_000);
    timeout.unref();
  };
  const onSignal = () => stop();
  dependencies.signals.on("SIGINT", onSignal);
  dependencies.signals.on("SIGTERM", onSignal);

  const launch = (args: string[], name: string): ChildProcess => {
    const child = dependencies.spawnChild(args);
    active.add(child);
    child.once("error", () => stop(`Failed to start ${name}.`));
    child.once("close", () => {
      active.delete(child);
      if (!stopping) stop(`${name} stopped unexpectedly.`);
      if (stopping && active.size === 0) done();
    });
    return child;
  };

  try {
    const ui = launch(["ui", ...homeArgs, "--port", String(options.port), "--host", options.host], "UI");
    ui.on("message", (message: unknown) => {
      if (stopping || !message || typeof message !== "object" || !("type" in message) || message.type !== "inoai-ui-ready") return;
      ui.removeAllListeners("message");
      dependencies.report(`UI: http://${options.host}:${options.port}`);
      try { launch(homeArgs, "Agent"); } catch { stop("Failed to start agent."); }
    });
    await finished;
    return exitCode;
  } finally {
    if (timeout) clearTimeout(timeout);
    dependencies.signals.off("SIGINT", onSignal);
    dependencies.signals.off("SIGTERM", onSignal);
  }
}
