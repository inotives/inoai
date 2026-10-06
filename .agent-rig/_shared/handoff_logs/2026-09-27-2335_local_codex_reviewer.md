---
agent: reviewer
role: reviewer
tool: codex
task: task-0003
task_title: "Phase 1: Runtime home bootstrap"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0003 lifecycle re-review handoff

Task 0003 still has one P1 lifecycle defect.

- `src/index.ts:26` — `await new Promise<void>(() => undefined)` does not keep Node's event loop alive. The executable logs startup then exits normally without calling `release()`, leaving `inoai.lock` behind and blocking the next core. Reproduced in a disposable deployment: the child exited with code 0 in 300 ms and its alternate-home lock still existed. Keep the process alive with a real active handle or redesign the startup lifecycle, and test that it remains running until SIGTERM and removes its lock on shutdown.

The helper/unit tests, typecheck, and diff check pass, but the executable test currently only observes initial stdout and not continued liveness or cleanup.

## Suggested skills

- `tdd` for the executable liveness and shutdown-cleanup regression.
- `ponytail` for the smallest real lifecycle handle.
- `review` after the lifecycle fix is ready.
