---
id: task-0061
title: "Phase 6: Daily review scheduling and priority"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0060
message: "Daily review scheduler: once per date, chat-first preemption, retries,
  skips; re-review clean, 187 tests"
---






# Task

## Context

The engine (task-0060) reviews one Session; this task decides when reviews run relative to chat work. `src/conversation-worker.ts` owns the chat queue and FIFO modes.

Sources: Phase 6 in `docs/implementation-phases.md`, the proposal's "Persisted inoai memory" and "Memory review loop" sections, `docs/sqlite-schema.md` (memory_reviews, memories, review notes), ADRs 0002, 0010, `docs/plan-review.md` decision 30, `CONTEXT.md` (Recap, Memory Review, Memory Signal, Manual Memory Entry). Live verification is Claude only; Codex is fake-tested; OpenCode skips reviews.

## Goal

Run one silent daily cycle that never delays chat.

## Scope

- Local timer: after `MEMORY_REVIEW_TIME` local time, run at most one cycle per local date, recorded as a `memory_review_cycle` Event; catch up once at startup/wake if the time has passed and today's cycle has not run.
- Enqueue one `memory_reviews` row per Session (active or ended) with new completed Messages; runtimes without a `review` method (Codex and OpenCode in V1) record `memory_review_skipped` and enqueue nothing, leaving cursors unchanged.
- Start a review only when no user Message is pending or processing; if a user Message arrives mid-review, cancel the review call, return the row to `pending` without consuming an attempt, record `memory_review_deferred`; after five deferrals in a day leave it for the next cycle.
- On failure, retry at most three times that day after 1, 2, and 4 hours (`next_attempt_at`), then leave `failed` until the next cycle; stale `processing` reviews return to `pending` on restart.
- When a completed review's `throughMessageId` is short of the range (the engine's 60-window cap), enqueue a follow-up row for the remainder in the same cycle. Treat a thrown commit error (e.g. `RangeError` from `createMemoryReview`) as a failed, replay-safe attempt (task-0060 review notes).
- A queued row's `from_message_id` must be the first Message id after the Session's completed cursor (even if that Message is a failed one or a notice), or the engine returns `stale_range` (task-0060 M2 check).
- Small carry-over from the task-0060 final review (Info): in `src/memory-review.ts`, widen the `politeRequest` lookahead to `(?!\s*[,:]?\s+QW)` and `danglingValue` to `[:=]\s*["']?\s*$`, each with one test case.
- Reviews never post to the chat transport; shutdown cancels an active review cleanly.
- Tests with fake clock/runtime: once per date across restarts, catch-up, chat-first at the scheduled time, mid-review preemption without attempt use, deferral cap, retry schedule and cap, no Discord sends, Codex and OpenCode skip with cursors unchanged.

## Planner Notes

Do not change chat Turn ordering or FIFO semantics. Inject the clock for tests.

## Implementation Plan

1. Implement the cycle and queue integration → verify: fake-clock tests.
2. Wire into startup/shutdown → verify: full checks.

## Acceptance Criteria

- [ ] One cycle per local date with startup catch-up.
- [ ] Chat always runs first and preemption consumes no attempt.
- [ ] Retries and caps follow the plan; reviews are silent.

## Notes

- 2026-10-03 worker: Added `src/memory-review-scheduler.ts` (`MemoryReviewScheduler`, injectable clock and interval). It checks at startup and every minute. Once the local time passes `MEMORY_REVIEW_TIME`, it runs one cycle per local date, recorded as `memory_review_cycle` with `date=YYYY-MM-DD; enqueued=N` and idempotent across restarts.
  - Runtimes without `review` record `memory_review_skipped` (`reason=unsupported_runtime`) and enqueue nothing.
  - Each non-deleted Session gets at most one open row. `from` is the first Message after the cursor and `through` is the last settled Message. A Session is skipped when its range has no completed Message.
  - A new cycle re-arms an existing pending or failed row in place (attempts reset to 0) instead of creating a duplicate. A row whose range changed is retired (soft-deleted) and replaced.
  - The runner starts one due row at a time, and only when no user Message is processing or pending in an active Session.
  - Preemption hook: `ConversationWorker.onQueueChange(listener)` is called at the end of every `wake()`. `index.ts` wires it to `scheduler.poke()`, which reads the queue from SQLite and aborts the review.
  - Cancelled results:
    - Chat preemption returns the row to pending with no attempt used and records `memory_review_deferred` (`review=ID; date=D; deferrals=N`). The 5th deferral in a day sets `next_attempt_at` to the next cycle time.
    - A shutdown abort returns the row to pending with no Event.
  - Other results:
    - `completed` short of the row's end enqueues a follow-up row for the remainder.
    - `empty` completes the row with a NULL recap plus a `memory_review_completed` `empty=1` Event, so the cursor moves on.
    - `stale_range` replaces the row with the re-derived range. If the same range comes back, it counts as a failed attempt.
    - `failed` and thrown commit errors (`commit_error`) take an attempt with backoff of +1h/+2h/+4h, then the row stays `failed` until the next cycle re-arms it.
  - Shutdown calls `scheduler.stop()` (abort and await) before `worker.stop()` closes the runtime.
  - Widened the `politeRequest` lookahead and `danglingValue` regexes, with one test case each.
  - Tests went from 176 to 187 (new `src/test/memory-review-scheduler.test.ts`, 11 tests).
- 2026-10-03 worker (review fix): Applied both Low findings from the reviewer.
  - Chat-first cycle: `poke()` now returns early while `chatBusy()` is true, before `runCycleIfDue()`. The daily enqueue transaction therefore never runs inside a chat wake with a claimed Turn; it runs on the next idle poke or 60 s tick. `deriveRange` selects only `id, state` with the same bounds as `messagesForMemoryReview`.
  - Deterministic `run()`: optional 4th parameter `RunDependencies { schedulerClock?: SchedulerClock }` is passed to the scheduler; production omits it (system clock). The wired `run()` tests that reach `scheduler.start()` (three `fakeRuntime` tests, the Claude subscription test, the OpenCode test) pin the clock to 05:00 local before the 06:00 review time with no timer. The Claude test also asserts no `memory_review*` Events.
  - Test count unchanged at 187; the "user Message at the scheduled time" test now expects no row or cycle Event until chat settles, then `enqueued=2` and a completed review.
