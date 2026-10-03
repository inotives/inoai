---
agent: reviewer
role: reviewer
tool: claude
task: task-0061
task_title: "Phase 6: Daily review scheduling and priority"
status: done
---

# task-0061 re-review (after fix round)

**Verdict: clean.** I found no new issues. Both Low findings from `2026-10-03-1230_phase6-0061_claude_reviewer.md` are resolved.

I made no implementation edits, did not change the task status, did not commit, ran no real CLI, and did not read any `.inoai-connect*/.env`.

## Low 1: chat-first cycle (resolved)

The fix is in `src/memory-review-scheduler.ts:75-91`. `poke()` computes `chatBusy()` once and then does the following:

- **Review active and chat busy:** it aborts the review with `"preempted"` and returns.
- **Review active and chat idle:** it returns without doing anything.
- **No review active and chat busy:** it returns before `runCycleIfDue()`, so the enqueue transaction never runs inside a chat `wake()`.
- **No review active and chat idle:** it runs the cycle, then `claimDue`.

The test at `src/test/memory-review-scheduler.test.ts:167-190` covers this. While chat is pending, after `start()` and after an extra `poke()`, there are 0 rows, no cycle Event and 0 calls. After `settle()` plus `poke()`, the cycle Event reads `enqueued=2` and the review completes with 0 attempts used.

The preemption test, "chat arriving through the worker preempts a review…", still passes.

### Cursor bounds match exactly

**`deriveRange`** (`:158-161`) uses:

```
id > COALESCE((SELECT MAX(through_message_id) FROM memory_reviews WHERE session_id = ? AND state = 'completed' AND deleted_at IS NULL), 0) AND deleted_at IS NULL ORDER BY id
```

This WHERE and ORDER BY match `messagesForMemoryReview` (`database.ts:731-735`) character for character. The only difference is that it selects `id, state` instead of `*`.

**The engine** (`memory-review.ts`):

- `completedCursor` uses the same `MAX(through_message_id)` subquery and the same `?? 0`.
- `selectRange` iterates `messagesForMemoryReview`.
- The M2 check (`:343`) compares `messages[0].id` with `from_message_id`. `deriveRange` uses `from = messages[0].id`, the first row of the same query, so the two agree.
- `from > cursor` holds by construction, so the `from_message_id <= cursor` guard at `:338` also passes.

There is no off-by-one. The completed-review tests would fail with `stale_range` if one existed.

## Low 2: deterministic `run()` (resolved)

**Production path.** `src/index.ts` exports `RunDependencies = { schedulerClock?: SchedulerClock }`. `run()` takes it as an optional 4th parameter, `supplied = {}`, and passes `clock: supplied.schedulerClock`. The scheduler falls back to `systemClock` when the clock is undefined (`memory-review-scheduler.ts:58`), so production uses the system clock.

**Test clock.** `src/test/transport.test.ts:182` defines `beforeReviewTime`. It fixes `now` at 2026-10-03 05:00 local, before `MEMORY_REVIEW_TIME=06:00`, and its `setInterval` is a no-op.

**Wired `run()` tests that reach `scheduler.start()` (`index.ts:445`).** All of them pass `beforeReviewTime`:

- `:372`, `:612` and `:639`, which use `fakeRuntime`;
- `:801`, the Claude subscription test, which also asserts that no `memory_review*` Events exist;
- `:882`, the OpenCode test.

**Wired `run()` tests that omit it.** These all throw before `scheduler.start()`:

- `:669`, Claude CLI unavailable;
- `:697`, OpenCode CLI unavailable;
- `:780`, credential refusal before login.

No other test file calls `run([`.

## Regression check

- **Chat ordering and FIFO:** `conversation-worker.ts` changes only in the `finally` listener (skipped while stopping) and the `onQueueChange` setter. Claim order and modes are unchanged.
- **Shutdown order:** `transport.stop()`, then `scheduler.stop()`, then `worker.stop()`, then `runtime.close()`. This is unchanged.
- **Prior review items:** everything confirmed in the prior review still holds. That covers the silent reviews, retry backoff and cap, the deferral cap, `commit_error`, follow-up rows, stale recovery, the regex widenings and the Codex/OpenCode skip.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 187 tests, 187 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `npm run typecheck` | Clean |
| `npm run build` | Clean |
| `git diff --check` | Clean |
| `git diff --no-index --check /dev/null` on every untracked file | No output |
| Scheduler, transport and conversation-worker test files, 2 runs each under local TZ, `TZ=Etc/GMT-14` and `TZ=Etc/GMT+12` | 49/49 pass in all 6 runs |

## Residual risk

The first cycle can wait up to 60 s after chat goes idle, because it waits for the next poke or timer tick. This was accepted in the prior review.
