---
agent: worker
role: worker
tool: claude
task: task-0061
task_title: "Phase 6: Daily review scheduling and priority"
status: handoff
---

# task-0061 worker fix handoff

This handoff fixes both Low findings from `2026-10-03-1230_phase6-0061_claude_reviewer.md`. I did not commit or stage anything, ran no real CLI, and did not read any `.inoai-connect*/.env`. Chat claim order and FIFO are unchanged.

## Changes

### Low 1: the daily cycle no longer runs while chat is busy

- **`src/memory-review-scheduler.ts:78-83`:** `poke()` computes `chatBusy()` once.
  - If a review is active, it still aborts that review when chat is busy.
  - Otherwise, when chat is busy it returns before `runCycleIfDue()`.
  - The enqueue transaction therefore never runs inside a chat `wake()` while a Turn is claimed. The cycle runs on the next idle poke or on the 60 s timer.
- **`src/memory-review-scheduler.ts:157-161`:** `deriveRange` now selects only `id, state`. It uses the same cursor bounds as `messagesForMemoryReview` but does not load Message bodies. The scheduler no longer imports `messagesForMemoryReview`; the engine still uses it.

### Low 2: `run()` can take a fixed scheduler clock

- **`src/index.ts:16`, `329-332` and `392`:** `run()` has a new optional 4th parameter, `supplied: RunDependencies = {}`, where `RunDependencies` is `{ schedulerClock?: SchedulerClock }`. It is passed to the scheduler as `clock`. Production passes nothing, so the scheduler keeps the system clock.
- **`src/test/transport.test.ts:182`:** new `beforeReviewTime`. It fixes `now` at 2026-10-03 05:00 local, before the 06:00 `MEMORY_REVIEW_TIME` in `validEnv`, and uses a no-op interval. No cycle can start at any time of day, so no review can run against the fake `claude` or the real HOME.
- **Where it is used:** every wired `run()` test that reaches `scheduler.start()`:
  - the three `fakeRuntime` tests (`:372`, `:612`, `:639`);
  - the Claude subscription test (`:801`);
  - the OpenCode test (`:882`).
  The refusal and missing-CLI tests fail before the scheduler starts, so they were left unchanged.
- **`src/test/transport.test.ts:829`:** the Claude test now also asserts that no `memory_review*` Event exists.

## Test updates

**`src/test/memory-review-scheduler.test.ts:167-190`.** This test is now named "...the cycle and the review start once chat is idle". It asserts:

1. While chat is pending, after `start()` and after another `poke()`: no `memory_reviews` row, no `memory_review_cycle` Event, and 0 review calls.
2. After chat settles and the scheduler is poked:
   - the cycle Event is `date=2026-10-03; enqueued=2`, because the settled chat Session now has a completed Message too;
   - the review completes with 0 attempts used.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 187 pass, 0 fail, 0 skipped (count unchanged) |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on every untracked file | No output |
| Scheduler, transport and conversation-worker test files, 3 runs each in local time, `TZ=Etc/GMT-14` and `TZ=Etc/GMT+12` | 49/49 in all 9 runs |

## Remaining risk

The first cycle can now wait up to 60 s after chat goes quiet if the last `wake()` still sees a `processing` Message. This is the same accepted behaviour as a review restart.
