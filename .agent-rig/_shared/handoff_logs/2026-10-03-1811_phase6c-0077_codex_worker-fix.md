---
agent: codex
role: worker
tool: codex
task: task-0077
task_title: "Phase 6c: Integrated review and acceptance"
status: handoff
---

# Task 0077 production-wiring fix

Implemented the integrated-review finding that configured BigQuery sync was not connected to the running application.

## Changes

- Added `@google-cloud/bigquery` as the official client dependency.
- Added an ADC-backed BigQuery client that creates the configured analytics tables and performs keyed `MERGE` upserts using `(agent_instance_id, source_id)`.
- Kept credentials out of configuration, rows, and logs; the client relies on host Application Default Credentials.
- Wired optional client and scheduler construction into `start()`.
- Starts the BigQuery scheduler after normal transport startup and stops it before SQLite/runtime-home release.
- Preserved disabled behavior when BigQuery configuration is absent and retained non-blocking retry/failure behavior in the existing scheduler.
- Added a lifecycle test proving configured startup schedules an export and release clears the scheduler; it uses a fake client and clock.

## Verification

- `npm test` — 206 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

No live BigQuery export was performed in this worker task. The configured production path is now present for independent reviewer validation.
