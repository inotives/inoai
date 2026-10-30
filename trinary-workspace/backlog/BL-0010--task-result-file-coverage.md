---
id: BL-0010
title: result.md for cancelled and recovered Task Runs
type: bug
status: promoted
created_at: 2026-10-23T15:08:00Z
source: IP-0002 T-0003 reviewer handoffs 1–3
promoted_to: IP-0005
---

# BL-0010: result.md for cancelled and recovered Task Runs

## Description

IP-0002 T-0003 writes `results/<task>/<run>/result.md` for completed and failed runs. Two gaps remain:

- A run cancelled while it completes can end `cancelled` in SQLite while `result.md` says `State: completed`. `writeResult(..., "completed")` runs before `completeTaskRun`, and a concurrent `cancelTask` can commit in between.
- Cancelled runs and runs failed by startup `recoverTaskRuns` get no `result.md`, because those paths do not go through the executor.

## Reproduction

- Steps to reproduce: cancel a task in the window between `writeResult` and `completeTaskRun`; or restart the agent while a task run is processing.
- Expected: `result.md` matches the run's final state, and every ended run has a `result.md`.
- Actual: stale `State: completed`; no `result.md` for cancelled or recovered runs.

## Context and evidence

- Source: IP-0002 T-0003 reviewer handoffs 1–3 and worker handoffs 2–3 (`trinary-workspace/features/IP-0002--ui-task-management/tasks/T-0003--executor-results-and-threads/handoffs/`, local).
- Fix ideas: a `cancelled` state in `result.md`, or rewrite it when `completeTaskRun` rejects a run that is no longer processing; write a short `result.md` from the recovery path.

## Discussion

- [2026-10-30] Promoted to IP-0005 (Task run reliability) on branch `feat/task-run-reliability`. The feature README is canonical from now on.

## Open questions

- Should the UI run history (T-0005) show runs without `result.md` differently?
