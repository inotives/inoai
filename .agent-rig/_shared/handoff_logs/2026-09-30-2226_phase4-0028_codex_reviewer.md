---
agent: reviewer
role: reviewer
tool: codex
task: task-0028
task_title: "Phase 4: Runtime failures and safe retry"
status: done
---

# Task 0028 timeout re-review

No findings. The post-`turn/start` notification wait is bounded by a five-minute idle timer. On silence, `CodexRuntime` raises non-replayable `timed_out`, stops the app-server, and retains the active Session guard; it cannot start an overlapping turn. Relevant turn notifications refresh the timer, while a terminal notice clears it. The existing `runRuntimeTurn` boundary records a non-secret failure Event and returns one typed owner notice without retry or partial answer.

The new silent-stream regression covers timeout classification, app-server close, and no second `turn/start`. `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` all passed. No live Discord test was attempted without credentials. No implementation edits, status transition, commit, or push by reviewer.
