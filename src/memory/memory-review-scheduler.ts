import type { AgentRuntime } from "../application/conversation/runtime-port.js";
import type { MemoryReviewRecord, MessageRecord } from "../persistence/legacy-database.js";
import { reviewSessionWithStore } from "./memory-review.js";
import type { MemoryReviewResult } from "./memory-review.js";
import type { OperationalStore } from "../persistence/operational-store.js";

// The daily Memory Review cycle (Phase 6). It enqueues one memory_reviews row per Session with new settled
// Messages and runs due rows one at a time, only while no user Message is pending or processing. It holds no
// transport: reviews are silent. Scheduling fields (next_attempt_at, started_at) use the injected clock; audit
// columns keep SQLite's own time.

const actor = "memory-review-scheduler";
const retryDelayHours = [1, 2, 4];
const maxDeferralsPerDay = 5;
const checkIntervalMs = 60_000;

export type SchedulerClock = {
  now(): Date;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const systemClock: SchedulerClock = {
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type MemoryReviewSchedulerOptions = {
  reviewTime: string;
  maxChars: number;
  clock?: SchedulerClock;
  onFailure?: (error: Error) => void;
};

type ActiveReview = { controller: AbortController; done: Promise<void> };

const pad = (value: number) => String(value).padStart(2, "0");
export const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export class MemoryReviewScheduler {
  private readonly clock: SchedulerClock;
  private readonly hour: number;
  private readonly minute: number;
  private interval: unknown;
  private active: ActiveReview | undefined;
  private started = false;
  private stopped = false;
  private pokePromise: Promise<void> | undefined;
  private pokeRequested = false;

  constructor(
    private readonly database: OperationalStore,
    private readonly runtime: AgentRuntime,
    private readonly options: MemoryReviewSchedulerOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    const match = /^(\d{2}):(\d{2})$/.exec(options.reviewTime);
    if (!match) throw new RangeError("Memory review time must be HH:MM");
    [this.hour, this.minute] = [Number(match[1]), Number(match[2])];
  }

  // The startup check doubles as the catch-up; the periodic check also covers sleep and wake.
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.interval = this.clock.setInterval(() => this.poke(), checkIntervalMs);
    void this.poke();
  }

  // Called on every chat queue change and by the timer. Preempts an active review when chat work exists; otherwise
  // runs the daily cycle when due and starts the next due review. While chat is busy neither runs, so the cycle's
  // enqueue transaction never delays a claimed Turn; it runs on the next idle poke or timer tick.
  poke(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve();
    if (this.pokePromise) { this.pokeRequested = true; return this.pokePromise; }
    this.pokePromise ??= this.runPoke().finally(() => { this.pokePromise = undefined; });
    return this.pokePromise;
  }

  private async runPoke(): Promise<void> {
    try {
      const busy = await this.chatBusy();
      if (this.active) {
        if (busy) this.active.controller.abort("preempted");
        if (this.pokeRequested && !this.stopped) { this.pokeRequested = false; await this.runPoke(); }
        return;
      }
      if (busy) {
        if (this.pokeRequested && !this.stopped) { this.pokeRequested = false; await this.runPoke(); }
        return;
      }
      await this.runCycleIfDue();
      if (!this.runtime.review) {
        if (this.pokeRequested && !this.stopped) { this.pokeRequested = false; await this.runPoke(); }
        return;
      }
      const row = await this.claimDue();
      if (row) this.run(row);
      if (this.pokeRequested && !this.stopped) {
        this.pokeRequested = false;
        await this.runPoke();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async idle(): Promise<void> {
    while (this.active || this.pokePromise) await Promise.all([...(this.active ? [this.active.done] : []), ...(this.pokePromise ? [this.pokePromise] : [])]);
  }

  // Aborts an active review and waits for it to settle, so the caller can close the runtime afterwards.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval !== undefined) this.clock.clearInterval(this.interval);
    this.interval = undefined;
    this.active?.controller.abort("shutdown");
    await this.idle();
  }

  private fail(error: unknown): void {
    this.options.onFailure?.(error instanceof Error ? error : new Error("Memory review scheduler failed"));
  }

  // A pending user Message counts only in an active Session, because only those can ever be claimed; a stranded one
  // must not starve reviews forever.
  private async chatBusy(): Promise<boolean> {
    return this.database.chatBusy();
  }

  private scheduledOn(date: Date, dayOffset = 0): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, this.hour, this.minute);
  }

  private nextCycleTime(now: Date): Date {
    const today = this.scheduledOn(now);
    return today > now ? today : this.scheduledOn(now, 1);
  }

  private async runCycleIfDue(): Promise<void> {
    const now = this.clock.now();
    if (now < this.scheduledOn(now)) return;
    const date = localDate(now);
    if ((await this.database.listEvents()).some((event) => event.event_type === "memory_review_cycle" && (event.detail ?? "").startsWith(`date=${date};`))) return;
    let enqueued = 0;
      if (!this.runtime.review) {
        // Codex and OpenCode in V1: nothing is enqueued and every cursor stays where it is.
        await this.database.createEvent({ session_id: null, message_id: null, event_type: "memory_review_skipped",
          detail: `date=${date}; reason=unsupported_runtime` }, actor);
      } else {
        const sessions = await this.database.listSessions();
        for (const { id } of sessions) if (await this.enqueue(id, now)) enqueued++;
      }
      await this.database.createEvent({ session_id: null, message_id: null, event_type: "memory_review_cycle",
        detail: `date=${date}; enqueued=${enqueued}` }, actor);
  }

  // The range a row for this Session must cover now: from the first Message after the completed cursor (whatever its
  // state, as the engine requires) through the last settled Message before any pending or processing one. Undefined
  // when that range holds no completed Message.
  private async deriveRange(sessionId: number): Promise<{ from: number; through: number } | undefined> {
    return this.database.deriveMemoryReviewRange(sessionId);
  }

  // One open row per Session at most. A new cycle re-arms an open (pending or failed) row: attempts and its schedule
  // reset, so a row left failed yesterday gets a fresh day of retries instead of a duplicate. A row whose range no
  // longer matches is replaced, and one with nothing left to review is soft-deleted.
  private async enqueue(sessionId: number, now: Date): Promise<boolean> {
    const open = await this.database.listOpenMemoryReviews(sessionId);
    if (open.some((row) => row.state === "processing")) return false;
    const range = await this.deriveRange(sessionId);
    const [current, ...extra] = open;
    for (const row of extra) await this.retire(row);
    if (!range) {
      if (current) await this.retire(current);
      return false;
    }
    if (current && current.from_message_id === range.from && current.through_message_id === range.through) {
      await this.database.updateMemoryReview(current.id, { state: "pending", attempts: 0, nextAttemptAt: seconds(now), failureDetail: null }, actor);
      return true;
    }
    if (current) await this.retire(current);
    await this.insert(sessionId, range.from, range.through, now);
    return true;
  }

  private async insert(sessionId: number, from: number, through: number, now: Date): Promise<MemoryReviewRecord> {
    const row = await this.database.createMemoryReview({ session_id: sessionId, from_message_id: from, through_message_id: through }, actor);
    await this.database.updateMemoryReview(row.id, { state: "pending", nextAttemptAt: seconds(now) }, actor);
    return row;
  }

  // Soft-delete keeps the row for inspection; it leaves the open state so it is never claimed or recovered again.
  private async retire(row: MemoryReviewRecord): Promise<void> {
    await this.database.retireMemoryReview(row.id, actor);
  }

  private async claimDue(): Promise<MemoryReviewRecord | undefined> {
    const now = seconds(this.clock.now());
    return this.database.claimDueMemoryReview(now, actor);
  }

  private run(row: MemoryReviewRecord): void {
    const controller = new AbortController();
    const done = (async () => {
      let result: MemoryReviewResult | { state: "failed"; reason: "commit_error" };
      try {
        result = await reviewSessionWithStore(this.database, this.runtime, row.session_id, { reviewId: row.id, maxChars: this.options.maxChars, signal: controller.signal });
      } catch {
        // The engine rolled its commit back, so a thrown error is a failed, replay-safe attempt.
        result = { state: "failed", reason: "commit_error" };
      }
      await this.settle(row, result, controller.signal);
    })().catch((error: unknown) => this.fail(error)).finally(() => {
      this.active = undefined;
      this.poke();
    });
    this.active = { controller, done };
  }

  private async settle(row: MemoryReviewRecord, result: MemoryReviewResult | { state: "failed"; reason: "commit_error" }, signal: AbortSignal): Promise<void> {
    const now = this.clock.now();
    const update = (values: { state?: string; attempts?: number; failureDetail?: string | null; nextAttemptAt?: number | null }) => this.database.updateMemoryReview(row.id, values, actor);
    if (result.state === "completed") {
      // The engine's window cap ended the range early: the remainder is reviewed next, in this same cycle.
      if (result.throughMessageId < row.through_message_id) {
        const messages = await this.database.messagesForMemoryReview(row.session_id);
        const next = messages.find((message) => message.id > result.throughMessageId);
        if (next && next.id <= row.through_message_id) await this.insert(row.session_id, next.id, row.through_message_id, now);
      }
      return;
    }
    if (result.state === "empty") {
      // Nothing reviewable (only notices, failed or non-owner Messages): the row completes without a Recap so the
      // cursor moves past them and no row stays pending forever. Recap lookups skip a NULL recap.
        if (await update({ state: "completed" })) {
          await this.database.createEvent({ session_id: row.session_id, message_id: null, event_type: "memory_review_completed",
            detail: `review=${row.id}; through=${row.through_message_id}; added=0; updated=0; deleted=0; ignored=0; empty=1` }, actor);
        }
      return;
    }
    if (result.state === "skipped") {
      await update({ state: "pending" });
      return;
    }
    if (signal.aborted) {
      // Cancelled by chat or shutdown: back to pending without using an attempt. Only chat counts as a deferral.
      if (signal.reason !== "preempted") {
      await update({ state: "pending" });
        return;
      }
      const date = localDate(now);
      const prefix = `review=${row.id}; date=${date};`;
      const count = (await this.database.listEvents(row.session_id)).filter((event) => event.event_type === "memory_review_deferred" && (event.detail ?? "").startsWith(prefix)).length;
      const deferrals = count + 1;
        // After the fifth deferral in a day the row waits for the next cycle.
        if (deferrals >= maxDeferralsPerDay) await update({ state: "pending", nextAttemptAt: seconds(this.nextCycleTime(now)) });
        else await update({ state: "pending" });
        await this.database.createEvent({ session_id: row.session_id, message_id: null, event_type: "memory_review_deferred",
          detail: `${prefix} deferrals=${deferrals}` }, actor);
      return;
    }
    if (result.reason === "stale_range") {
      // The row no longer starts at the next unreviewed Message. Replace it with the current range; the same range
      // coming back stale is a real failure and uses an attempt, so this can never loop.
      const range = await this.deriveRange(row.session_id);
      if (!range || range.from !== row.from_message_id || range.through !== row.through_message_id) {
        await this.retire(row);
        if (range) await this.insert(row.session_id, range.from, range.through, now);
        return;
      }
    }
    // Retry after 1, 2, and 4 hours, then stay failed until the next cycle re-arms the row.
    const attempts = row.attempts + 1;
    if (attempts <= retryDelayHours.length) {
      await update({ state: "pending", attempts, failureDetail: result.reason,
        nextAttemptAt: seconds(now) + retryDelayHours[attempts - 1] * 3600 });
    } else {
      await update({ state: "failed", attempts, failureDetail: result.reason });
    }
  }
}
