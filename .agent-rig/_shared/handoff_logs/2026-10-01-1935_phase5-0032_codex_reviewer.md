---
agent: reviewer
role: reviewer
tool: codex
task: task-0032
task_title: "Phase 5: FIFO conversation worker"
status: blocked
---

# Task 0032 independent review

## Finding

1. **Shutdown can start a new runtime attempt after closing the runtime.** `ConversationWorker.stop()` sets `stopping`, calls `cancel()`, and closes the runtime before awaiting the active drain (`src/conversation-worker.ts:35-42`). `process()` does not pass shutdown state into `runRuntimeTurn()` (`src/conversation-worker.ts:70`), whose retry-safe failure path waits and then starts another attempt (`src/runtime-turn.ts:50-52`). In a disposable-home fake-runtime reproduction, the first attempt raised `RuntimeFailure("pre_start", true)`; shutdown began during retry backoff; `runtime.close()` completed; then a second `runTurn()` ran and the Message became `completed` (`attempts=2`, `RETRY_AFTER_CLOSE`). This violates shutdown's no-new-turn boundary and can fail unpredictably against the real closed Codex app-server. Stop should prevent the next retry, settle the claimed Message safely, wait for the active turn to finish, and only then close the runtime. Add a deterministic regression test for shutdown during retry backoff.

## Verification

- `npm test`: 73 passed, 0 failed.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- Independently reproduced the shutdown/retry race with a fake runtime and isolated temporary runtime home; no developer runtime data, Discord token, or global Codex config was read.
- Other inspected paths—duplicate gateway archival, global FIFO claims, durable start/restart, same-Session non-overlap, and terminal failure continuation—matched the task contract in code and focused tests.

No implementation edits, task status change, commit, or push. Re-review task 0032 after a focused fix; do not unblock task 0033 yet.
