---
agent: reviewer
role: reviewer
tool: claude
task: task-0061
task_title: "Phase 6: Daily review scheduling and priority"
status: done
---

# task-0061 reviewer handoff

Verdict: **clean**. There are no blocking findings, so task-0061 can be marked `done`. Below are two Low items and some Info notes; none needs to be fixed before downstream work. I made no implementation edits, did not change the task status, did not commit, ran no real CLI, and did not read any `.inoai-connect*/.env`.

## Findings

### Low 1: the daily cycle runs synchronously inside the chat `wake()` path, even when chat is busy

- **Where:** `src/memory-review-scheduler.ts:74-84`, `124-148` and `153-163`; it is reached from `src/conversation-worker.ts:95-96`.
- **What happens:** `poke()` calls `runCycleIfDue()` before it checks `chatBusy()`. The listener runs in `wake()`'s `finally` block, after a Turn has been claimed and `process()` has run up to its first `await`. On the one wake per day when the cycle is due, the Turn's runtime start waits for that work. The work is:
  - a `BEGIN IMMEDIATE` transaction;
  - `messagesForMemoryReview` (`SELECT *`, full bodies) for every non-deleted Session.
- **Impact:** at most once per day, and it does not change Turn order. But the first cycle after Phase 6 ships loads the whole archive.
- **Fix:**
  - In `poke()`, return early when `chatBusy()` is true, before calling `runCycleIfDue()`. The cycle then runs on the next idle poke, or within 60 s from the timer. Reviews cannot start while chat is busy anyway, so nothing is lost.
  - Update the "user Message at the scheduled time" test so it expects no row until chat settles.
  - Optionally, have `deriveRange` select only `id` and `state`.

### Low 2: `run()` wires the scheduler to the real wall clock (test determinism)

- **Where:** `src/index.ts:383-387`.
- **Today the existing tests are deterministic.** Every wired `run()` test either:
  - fails before `scheduler.start()` (and `start()` is a no-op once `stop()` has run), or
  - asserts only filtered Event types or counts taken before start, or
  - starts the cycle before any Session exists (`enqueued=0`), or
  - uses a runtime without `review` (`fakeRuntime`, Codex, OpenCode).
- **I checked this directly:** `transport.test.js` and `conversation-worker.test.js` pass with local time on both sides of 06:00 (TZ `Etc/GMT+12`, `+6`, `GMT`, `-6`, `-12`; 38/38 each).
- **Residual risk 1:** if a test crosses local 06:00 while running, a cycle can fire mid-test. In the wired Claude test (`transport.test.ts` "Claude startup with the subscription login…"), that would enqueue the new Session and spawn a review with the fake `claude` script, which also touches `~/.claude/projects` cleanup under the real HOME.
- **Residual risk 2:** any task-0063 acceptance test that asserts a full Event list, or `memory_reviews` rows, after `run()` would depend on time of day.
- **Fix:**
  - Add a test seam: an optional scheduler clock, or an option to disable the scheduler, threaded through `run()`'s supplied-dependency parameters.
  - Use it in the wired `run()` tests. At minimum, task-0063 should inject a fixed clock rather than rely on the wall clock.

### Info

- **Abort overlap:** when a chat Message arrives mid-review, the chat Turn is claimed immediately and the review is aborted from the same `wake()`. Claude's review runs as its own child process with no lock shared with Turns (`claude-runtime.ts:152-192`). So chat is never delayed. The two Claude processes overlap only for the SIGINT plus at most the 2 s exit grace, which is a negligible subscription-quota cost. In global-FIFO mode chat is still claimed first, since reviews are not in the `messages` queue.
- **Review restart after chat:** the review restarts on the next `wake()` that finds chat idle. If the last wake after a Turn still sees the Message as `processing` (for example while delivery finishes), the restart waits for the 60 s timer. That is acceptable.
- **Ended-Session exclusion in `chatBusy`:** this is correct. `claimNextMessage` (`database.ts:518-520`) only claims Messages in `active` Sessions, and `resetSession` (`database.ts:636-650`) fails pending and processing user Messages in the same transaction that ends the Session (ADR 0004). So a stranded pending Message in an ended Session cannot normally arise, and if one did it could never be claimed. The behaviour matches `docs/sqlite-schema.md:205` in practice.
- **NULL recaps:**
  - Every downstream reader already filters `recap IS NOT NULL`: the engine's recap lookup (`memory-review.ts:358`) and recurrence validation via `isPriorRecap` (`memory-review.ts:395`).
  - Phase 7 and UI code that lists completed reviews must handle a NULL recap, shown as "no reviewable content" with `empty=1` in the Event.
  - `implementation-phases.md:244` ("no new Messages creates no Recap") still holds: a completed row with a NULL recap is not a Recap.
- **Stale or replaced rows** are retired with `state='failed'`, `failure_detail='stale_range'`, and `deleted_at`/`deleted_by`, with audit fields set. There are no physical deletes.

## What I verified

- **Chat ordering and FIFO:** the only change to `conversation-worker.ts` is the `finally` listener plus the `onQueueChange` setter. Claim order and modes are unchanged.
- **The hook cannot throw into chat:** `poke()` catches everything and routes it to a fixed-text `console.error`, and the listener is skipped while the worker is stopping.
- **Reviews are silent:** the scheduler holds no transport, and the preemption test asserts that only the chat answer is sent.
- **Cycle timing:**
  - It is due when `now >= local HH:MM` and no `memory_review_cycle` Event exists for `date=YYYY-MM-DD;`. That `LIKE` prefix is unambiguous.
  - Local `Date` construction makes a nonexistent DST time roll forward.
  - Startup acts as the catch-up, and nothing runs before the time.
  - Event details hold only the date and counts.
  - A runtime without `review` records a skip with no rows and no cursor change.
- **Enqueue range:**
  - `from` is `messages[0].id`, the first non-deleted Message after the completed cursor, whatever its state. This matches the engine's M2 rule (`memory-review.ts:343`) and `createMemoryReview`'s bounds.
  - `through` is the last settled Message before the first pending or processing one.
  - A Session needs at least one completed Message in range to get a row.
  - Ended Sessions are included, and each Session has at most one open row.
- **Results:**
  - The follow-up row uses the scheduler's in-memory original `through`. This is correct even though the engine rewrites the row's `through_message_id` (`memory-review.ts:388-390`).
  - A `stale_range` replacement cannot loop, because an identical re-derived range counts as a failed attempt.
  - Retries come at +1h, +2h and +4h, and the 4th failure leaves the row `failed`.
  - Deferrals are counted per review and per local date. The `review=1;` prefix does not match `review=10;`.
  - The 5th deferral sets `next_attempt_at` to the next cycle time.
  - A thrown commit error is recorded as `commit_error` with an attempt used.
- **Restart and shutdown:**
  - `recoverStaleWork` sets `processing` rows back to `pending` with attempts unchanged.
  - Shutdown runs `transport.stop()`, then `scheduler.stop()` (abort, then await), then `worker.stop()`, which closes the runtime.
  - The interval uses `unref()` and is cleared, and the fake-clock test asserts no timers are left.
- **Regex widenings:**
  - `politeRequest` now uses `(?!\s*[,:]?\s+QW)`.
  - `danglingValue` now uses `[:=]\s*["']?\s*$`.
  - Each has a test case (`memory-review.test.ts:415`, `:476`).

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 187 pass, 0 fail, 0 skipped, 0 todo (176 → 187; +11 scheduler tests; no `.skip` or `todo` in `src/test`) |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on the 4 untracked scheduler and memory-review files | No output |
| Scheduler, worker and memory-review test files, 5 reruns | 41/41 each time |
| Scheduler tests under `TZ` Australia/Sydney (DST starts Oct 4), America/New_York, Pacific/Chatham, Asia/Kolkata, UTC | 11/11 each |
| `transport` and `conversation-worker` tests with local time before and after 06:00 (5 `Etc/GMT±N` zones) | 38/38 each |

## Suggested follow-up

Fold Low 1 and Low 2 into task-0063, or into a small follow-up task: gate the cycle behind `chatBusy()`, and add a scheduler clock or disable seam to `run()` for wired tests.
