import type { DatabaseSync } from "node:sqlite";

import type { AgentRuntime } from "./agent-runtime.js";
import { createEvent, createMemoryReview } from "./database.js";
import type { MemoryReviewRecord, MessageRecord } from "./database.js";
import { reviewSession } from "./memory-review.js";
import type { MemoryReviewResult } from "./memory-review.js";

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

  constructor(
    private readonly database: DatabaseSync,
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
    this.poke();
  }

  // Called on every chat queue change and by the timer. Preempts an active review when chat work exists; otherwise
  // runs the daily cycle when due and starts the next due review. While chat is busy neither runs, so the cycle's
  // enqueue transaction never delays a claimed Turn; it runs on the next idle poke or timer tick.
  poke(): void {
    if (!this.started || this.stopped) return;
    try {
      const busy = this.chatBusy();
      if (this.active) {
        if (busy) this.active.controller.abort("preempted");
        return;
      }
      if (busy) return;
      this.runCycleIfDue();
      if (!this.runtime.review) return;
      const row = this.claimDue();
      if (row) this.run(row);
    } catch (error) {
      this.fail(error);
    }
  }

  async idle(): Promise<void> {
    while (this.active) await this.active.done;
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
  private chatBusy(): boolean {
    return !!this.database.prepare(`SELECT 1 FROM messages AS message WHERE message.direction = 'user' AND message.deleted_at IS NULL
      AND (message.state = 'processing' OR (message.state = 'pending' AND EXISTS (SELECT 1 FROM sessions
        WHERE sessions.id = message.session_id AND sessions.state = 'active' AND sessions.deleted_at IS NULL))) LIMIT 1`).get();
  }

  private scheduledOn(date: Date, dayOffset = 0): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, this.hour, this.minute);
  }

  private nextCycleTime(now: Date): Date {
    const today = this.scheduledOn(now);
    return today > now ? today : this.scheduledOn(now, 1);
  }

  private runCycleIfDue(): void {
    const now = this.clock.now();
    if (now < this.scheduledOn(now)) return;
    const date = localDate(now);
    if (this.database.prepare(`SELECT 1 FROM events WHERE event_type = 'memory_review_cycle' AND detail LIKE ?
      AND deleted_at IS NULL LIMIT 1`).get(`date=${date};%`)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let enqueued = 0;
      if (!this.runtime.review) {
        // Codex and OpenCode in V1: nothing is enqueued and every cursor stays where it is.
        createEvent(this.database, { session_id: null, message_id: null, event_type: "memory_review_skipped",
          detail: `date=${date}; reason=unsupported_runtime` }, actor);
      } else {
        const sessions = this.database.prepare("SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: number }>;
        for (const { id } of sessions) if (this.enqueue(id, now)) enqueued++;
      }
      createEvent(this.database, { session_id: null, message_id: null, event_type: "memory_review_cycle",
        detail: `date=${date}; enqueued=${enqueued}` }, actor);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // The range a row for this Session must cover now: from the first Message after the completed cursor (whatever its
  // state, as the engine requires) through the last settled Message before any pending or processing one. Undefined
  // when that range holds no completed Message.
  private deriveRange(sessionId: number): { from: number; through: number } | undefined {
    // Same bounds as messagesForMemoryReview, without loading every body.
    const messages = this.database.prepare(`SELECT id, state FROM messages
      WHERE session_id = ? AND id > COALESCE((SELECT MAX(through_message_id) FROM memory_reviews
        WHERE session_id = ? AND state = 'completed' AND deleted_at IS NULL), 0)
        AND deleted_at IS NULL ORDER BY id`).all(sessionId, sessionId) as Array<Pick<MessageRecord, "id" | "state">>;
    let through: number | undefined;
    let completed = false;
    for (const message of messages) {
      if (message.state === "pending" || message.state === "processing") break;
      through = message.id;
      completed ||= message.state === "completed";
    }
    return through !== undefined && completed ? { from: messages[0].id, through } : undefined;
  }

  // One open row per Session at most. A new cycle re-arms an open (pending or failed) row: attempts and its schedule
  // reset, so a row left failed yesterday gets a fresh day of retries instead of a duplicate. A row whose range no
  // longer matches is replaced, and one with nothing left to review is soft-deleted.
  private enqueue(sessionId: number, now: Date): boolean {
    const open = this.database.prepare(`SELECT * FROM memory_reviews WHERE session_id = ? AND state IN ('pending', 'processing', 'failed')
      AND deleted_at IS NULL ORDER BY id`).all(sessionId) as MemoryReviewRecord[];
    if (open.some((row) => row.state === "processing")) return false;
    const range = this.deriveRange(sessionId);
    const [current, ...extra] = open;
    for (const row of extra) this.retire(row);
    if (!range) {
      if (current) this.retire(current);
      return false;
    }
    if (current && current.from_message_id === range.from && current.through_message_id === range.through) {
      this.database.prepare(`UPDATE memory_reviews SET state = 'pending', attempts = 0, next_attempt_at = ?,
        updated_at = unixepoch(), updated_by = ? WHERE id = ?`).run(seconds(now), actor, current.id);
      return true;
    }
    if (current) this.retire(current);
    this.insert(sessionId, range.from, range.through, now);
    return true;
  }

  private insert(sessionId: number, from: number, through: number, now: Date): MemoryReviewRecord {
    const row = createMemoryReview(this.database, { session_id: sessionId, from_message_id: from, through_message_id: through }, actor);
    this.database.prepare("UPDATE memory_reviews SET next_attempt_at = ? WHERE id = ?").run(seconds(now), row.id);
    return row;
  }

  // Soft-delete keeps the row for inspection; it leaves the open state so it is never claimed or recovered again.
  private retire(row: MemoryReviewRecord): void {
    this.database.prepare(`UPDATE memory_reviews SET state = 'failed', failure_detail = 'stale_range', updated_at = unixepoch(),
      updated_by = ?, deleted_at = unixepoch(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`).run(actor, actor, row.id);
  }

  private claimDue(): MemoryReviewRecord | undefined {
    const now = seconds(this.clock.now());
    const row = this.database.prepare(`SELECT * FROM memory_reviews WHERE state = 'pending' AND next_attempt_at <= ?
      AND deleted_at IS NULL ORDER BY id LIMIT 1`).get(now) as MemoryReviewRecord | undefined;
    if (!row) return undefined;
    const claimed = this.database.prepare(`UPDATE memory_reviews SET state = 'processing', started_at = ?, updated_at = unixepoch(),
      updated_by = ? WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`).run(now, actor, row.id).changes === 1;
    return claimed ? row : undefined;
  }

  private run(row: MemoryReviewRecord): void {
    const controller = new AbortController();
    const done = (async () => {
      let result: MemoryReviewResult | { state: "failed"; reason: "commit_error" };
      try {
        result = await reviewSession(this.database, this.runtime, row.session_id, { reviewId: row.id, maxChars: this.options.maxChars, signal: controller.signal });
      } catch {
        // The engine rolled its commit back, so a thrown error is a failed, replay-safe attempt.
        result = { state: "failed", reason: "commit_error" };
      }
      this.settle(row, result, controller.signal);
    })().catch((error: unknown) => this.fail(error)).finally(() => {
      this.active = undefined;
      this.poke();
    });
    this.active = { controller, done };
  }

  private settle(row: MemoryReviewRecord, result: MemoryReviewResult | { state: "failed"; reason: "commit_error" }, signal: AbortSignal): void {
    const now = this.clock.now();
    const update = (sql: string, ...values: Array<string | number | null>) =>
      this.database.prepare(`UPDATE memory_reviews SET ${sql}, updated_at = unixepoch(), updated_by = ?
        WHERE id = ? AND state = 'processing' AND deleted_at IS NULL`).run(...values, actor, row.id);
    if (result.state === "completed") {
      // The engine's window cap ended the range early: the remainder is reviewed next, in this same cycle.
      if (result.throughMessageId < row.through_message_id) {
        const next = this.database.prepare(`SELECT MIN(id) AS id FROM messages WHERE session_id = ? AND id > ?
          AND deleted_at IS NULL`).get(row.session_id, result.throughMessageId) as { id: number | null };
        if (next.id !== null && next.id <= row.through_message_id) this.insert(row.session_id, next.id, row.through_message_id, now);
      }
      return;
    }
    if (result.state === "empty") {
      // Nothing reviewable (only notices, failed or non-owner Messages): the row completes without a Recap so the
      // cursor moves past them and no row stays pending forever. Recap lookups skip a NULL recap.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (update("state = 'completed', recap = NULL, completed_at = unixepoch()").changes === 1) {
          createEvent(this.database, { session_id: row.session_id, message_id: null, event_type: "memory_review_completed",
            detail: `review=${row.id}; through=${row.through_message_id}; added=0; updated=0; deleted=0; ignored=0; empty=1` }, actor);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    if (result.state === "skipped") {
      update("state = 'pending'");
      return;
    }
    if (signal.aborted) {
      // Cancelled by chat or shutdown: back to pending without using an attempt. Only chat counts as a deferral.
      if (signal.reason !== "preempted") {
        update("state = 'pending'");
        return;
      }
      const date = localDate(now);
      const prefix = `review=${row.id}; date=${date};`;
      const { count } = this.database.prepare(`SELECT COUNT(*) AS count FROM events WHERE event_type = 'memory_review_deferred'
        AND detail LIKE ? AND deleted_at IS NULL`).get(`${prefix}%`) as { count: number };
      const deferrals = count + 1;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        // After the fifth deferral in a day the row waits for the next cycle.
        if (deferrals >= maxDeferralsPerDay) update("state = 'pending', next_attempt_at = ?", seconds(this.nextCycleTime(now)));
        else update("state = 'pending'");
        createEvent(this.database, { session_id: row.session_id, message_id: null, event_type: "memory_review_deferred",
          detail: `${prefix} deferrals=${deferrals}` }, actor);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    if (result.reason === "stale_range") {
      // The row no longer starts at the next unreviewed Message. Replace it with the current range; the same range
      // coming back stale is a real failure and uses an attempt, so this can never loop.
      const range = this.deriveRange(row.session_id);
      if (!range || range.from !== row.from_message_id || range.through !== row.through_message_id) {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.retire(row);
          if (range) this.insert(row.session_id, range.from, range.through, now);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
        return;
      }
    }
    // Retry after 1, 2, and 4 hours, then stay failed until the next cycle re-arms the row.
    const attempts = row.attempts + 1;
    if (attempts <= retryDelayHours.length) {
      update("state = 'pending', attempts = ?, failure_detail = ?, next_attempt_at = ?", attempts, result.reason,
        seconds(now) + retryDelayHours[attempts - 1] * 3600);
    } else {
      update("state = 'failed', attempts = ?, failure_detail = ?", attempts, result.reason);
    }
  }
}
