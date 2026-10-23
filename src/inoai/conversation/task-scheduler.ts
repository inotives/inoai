import type { TaskOperationsStore } from "../connectors/persistence/sqlite/operational-store.js";
import type { SchedulerClock } from "../memory/memory-review-scheduler.js";
import type { TaskRunExecutor } from "./task-run-executor.js";

const checkIntervalMs = 60_000;
const systemClock: SchedulerClock = {
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class TaskScheduler {
  private readonly clock: SchedulerClock;
  private interval: unknown;
  private started = false;
  private stopped = false;
  private checking?: Promise<void>;
  private checkAgain = false;

  constructor(private readonly store: Pick<TaskOperationsStore, "listTasks">,
    private readonly runner: Pick<TaskRunExecutor, "start">,
    clock?: SchedulerClock, private readonly onFailure: (error: Error) => void = () => {}) {
    this.clock = clock ?? systemClock;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.interval = this.clock.setInterval(() => { void this.poke(); }, checkIntervalMs);
    void this.poke();
  }

  poke(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve();
    if (this.checking) { this.checkAgain = true; return this.checking; }
    this.checking = this.checkDue().catch((error: unknown) =>
      this.onFailure(error instanceof Error ? error : new Error("Task scheduler failed")))
      .finally(() => {
        this.checking = undefined;
        if (this.checkAgain && !this.stopped) { this.checkAgain = false; void this.poke(); }
      });
    return this.checking;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval !== undefined) this.clock.clearInterval(this.interval);
    this.interval = undefined;
    await this.checking;
  }

  private async checkDue(): Promise<void> {
    if (this.stopped) return;
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const due = (await this.store.listTasks()).filter((task) => task.state === "active" && task.next_due_at !== null && task.next_due_at <= now)
      .sort((a, b) => a.next_due_at! - b.next_due_at! || a.id - b.id);
    for (const task of due) {
      if (this.stopped) return;
      const result = await this.runner.start(task.id);
      if (result === "started" || result === "busy") return;
    }
  }
}
