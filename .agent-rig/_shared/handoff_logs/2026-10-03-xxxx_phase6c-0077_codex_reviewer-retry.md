---
agent: codex
role: reviewer
tool: codex
task: task-0077
task_title: "Phase 6c: Integrated review and acceptance"
status: done
---

# Task 0077 re-review

## Review result

Clean after the production-wiring fix.

- `createBigQueryClient()` uses the official `@google-cloud/bigquery` client with host ADC; no service-account key handling or credential logging was added.
- Configured tables are created lazily and rows are keyed by `(agent_instance_id, source_id)` through parameterized MERGE values.
- Missing or malformed optional BigQuery configuration leaves the normal application path enabled and the sync disabled.
- The scheduler is constructed during startup, starts only after transport startup in `run()`, and stops before the SQLite database/runtime-home lock is released.
- Export failures remain local, non-blocking, redacted, and retryable; watermarks, tombstones, and soft-deletion behavior remain intact.
- Lifecycle coverage verifies configured startup dependencies, an export, and scheduler cleanup; existing offline tests cover the unconfigured path.

No implementation edits were made. No live BigQuery export was performed during review; the configured production client path is covered by injected fake-client tests and uses ADC at runtime.

## Verification

- `npm test` — 206 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

No unresolved findings remain.
