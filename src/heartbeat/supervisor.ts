import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_INTERVAL_MS, HealthPolicy, type HealthResult, type ProbeTimer } from "./health.js";

export const CHILD_STOP_TIMEOUT_MS = 10_000;
export const CHILD_RETRY_DELAY_MS = 10_000;
export const RETRY_WINDOW_MS = 5 * 60_000;
export const MAX_RETRY_ATTEMPTS = 3;

export type SupervisorChild = {
  pid?: number;
  once(event: "exit" | "error", listener: () => void): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
};
export type SupervisorEvent = "started" | "healthy" | "degraded" | "restart" | "child-exit" | "spawn-failed" | "retry-limit" | "health-blocked" | "supervisor-failed" | "stopped";
export type SupervisorLog = (event: SupervisorEvent, error?: boolean) => Promise<void>;
export type SupervisorDependencies = {
  spawn(): SupervisorChild;
  probe(pid: number): Promise<HealthResult>;
  clock: ProbeTimer & { now(): number };
  log: SupervisorLog;
};

/** Only fixed event names are written. Never pass child output or raw errors here. */
export function localHeartbeatLog(directory = join(homedir(), "Library", "Logs", "inoai")): SupervisorLog {
  return async (event, error = false) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, error ? "heartbeat-error.log" : "heartbeat.log"),
      `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
  };
}

export function spawnInoai(connectDirectory: string, cwd: string, createChild: (command: string, args: string[], options: { cwd: string; shell: false; stdio: "ignore" }) => SupervisorChild = spawn): SupervisorChild {
  return createChild(process.execPath, [fileURLToPath(new URL("../index.js", import.meta.url)), "--connect-dir", connectDirectory],
    { cwd, shell: false, stdio: "ignore" });
}

export const supervisorClock: SupervisorDependencies["clock"] = {
  now: () => performance.now(),
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type OwnedChild = { process: SupervisorChild; exited: boolean; recovering: boolean; exit: Promise<void>; resolveExit(): void };

/** One serial lifecycle owns one child. Replacement waits for confirmed exit, including after SIGKILL. */
export class HeartbeatSupervisor {
  private child?: OwnedChild;
  private policy = new HealthPolicy();
  private timer?: unknown;
  private stopping = false;
  private started = false;
  private attempts: number[] = [];
  private work: Promise<void> = Promise.resolve();
  private resolveFinished!: (code: number) => void;
  readonly finished = new Promise<number>((resolve) => { this.resolveFinished = resolve; });

  constructor(private readonly dependencies: SupervisorDependencies) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.enqueue(() => this.launch(false));
  }

  stop(): Promise<number> {
    if (!this.stopping) {
      this.stopping = true;
      this.clearTimer();
      this.enqueue(() => this.finish(0));
    }
    return this.finished;
  }

  private enqueue(action: () => Promise<void>): void {
    this.work = this.work.then(action).catch(async () => {
      this.stopping = true;
      this.clearTimer();
      await this.dependencies.log("supervisor-failed", true).catch(() => undefined);
      await this.finish(1).catch(() => this.resolveFinished(1));
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.dependencies.clock.clear(this.timer);
    this.timer = undefined;
  }

  private schedule(milliseconds: number, action: () => Promise<void>): void {
    this.clearTimer();
    if (this.stopping) return;
    this.timer = this.dependencies.clock.set(() => {
      this.timer = undefined;
      this.enqueue(action);
    }, milliseconds);
  }

  private async launch(retry: boolean): Promise<void> {
    if (this.stopping) return;
    if (retry) {
      const now = this.dependencies.clock.now();
      this.attempts = this.attempts.filter((time) => now - time < RETRY_WINDOW_MS);
      if (this.attempts.length >= MAX_RETRY_ATTEMPTS) {
        await this.dependencies.log("retry-limit", true);
        this.stopping = true;
        await this.finish(1);
        return;
      }
      this.attempts.push(now);
    }
    let child: SupervisorChild;
    try { child = this.dependencies.spawn(); } catch {
      await this.dependencies.log("spawn-failed", true);
      this.schedule(CHILD_RETRY_DELAY_MS, () => this.launch(true));
      return;
    }
    let resolveExit!: () => void;
    const owned: OwnedChild = { process: child, exited: false, recovering: false,
      exit: new Promise<void>((resolve) => { resolveExit = resolve; }), resolveExit: () => resolveExit() };
    this.child = owned;
    this.policy = new HealthPolicy();
    const onExit = () => {
      if (owned.exited) return;
      owned.exited = true;
      owned.resolveExit();
      if (!this.stopping && !owned.recovering && this.child === owned) {
        this.clearTimer();
        this.enqueue(async () => {
          if (this.stopping || this.child !== owned) return;
          await this.dependencies.log("child-exit", true);
          this.schedule(CHILD_RETRY_DELAY_MS, () => this.launch(true));
        });
      }
    };
    child.once("exit", onExit);
    // Node emits error without exit when spawning fails. A running child error is
    // not exit confirmation (for example, a failed signal).
    child.once("error", () => {
      if (child.pid === undefined) onExit();
      else this.enqueue(async () => { throw new Error("Child process failure"); });
    });
    await this.dependencies.log("started");
    if (!owned.exited) this.schedule(HEARTBEAT_INTERVAL_MS, () => this.check(owned));
  }

  private async check(owned: OwnedChild): Promise<void> {
    if (this.stopping || this.child !== owned || owned.exited) return;
    const result = await this.dependencies.probe(owned.process.pid!);
    if (this.stopping || owned.exited) return;
    const decision = this.policy.evaluate(result);
    if (decision.action === "blocked") {
      await this.dependencies.log("health-blocked", true);
      this.stopping = true;
      await this.finish(1);
    } else if (decision.action === "restart") {
      await this.dependencies.log("restart");
      // Suppress the exit callback's retry while this operation owns recovery.
      owned.recovering = true;
      await this.terminate(owned);
      await this.launch(true);
    } else {
      await this.dependencies.log(decision.healthy ? "healthy" : "degraded");
      this.schedule(HEARTBEAT_INTERVAL_MS, () => this.check(owned));
    }
  }

  private async terminate(owned: OwnedChild): Promise<void> {
    if (owned.exited) return;
    owned.process.kill("SIGTERM");
    const handle = this.dependencies.clock.set(() => {
      if (!owned.exited) {
        try { owned.process.kill("SIGKILL"); } catch {
          // Exit is still unconfirmed. Keep ownership and never start a replacement.
          void this.dependencies.log("supervisor-failed", true).catch(() => undefined);
        }
      }
    }, CHILD_STOP_TIMEOUT_MS);
    try { await owned.exit; } finally { this.dependencies.clock.clear(handle); }
  }

  private async finish(code: number): Promise<void> {
    this.clearTimer();
    if (this.child) await this.terminate(this.child);
    await this.dependencies.log(code ? "supervisor-failed" : "stopped", code !== 0);
    this.resolveFinished(code);
  }
}
