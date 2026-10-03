---
agent: worker
role: worker
tool: codex
task: task-0073
task_title: "Phase 6c: BigQuery schema and exporter"
status: handoff
---

# Task 0073 worker handoff

Implemented a dependency-free, fake-client-friendly SQLite to BigQuery export boundary.

- Added `src/bigquery.ts` with stable definitions for `agent_instances`, `sessions`, `messages`, `memory_reviews`, `memories`, and `events`.
- Every row carries `agent_instance_id`, `agent_name`, source identity/audit timestamps, tombstones, and actor fields. Tables are partitioned by `source_updated_at`, clustered by `agent_instance_id`, and keyed by `(agent_instance_id, source_id)`.
- Exported text uses the existing `redactSecrets` helper. Approval rows, environment values, credentials, and raw tool payloads are not selected.
- Added `exportToBigQuery`, which is disabled when optional configuration/client is absent and catches client/cloud failures without throwing. It sends all current rows so a future reliable sync layer can add watermarks/retries without changing the table contract.
- Exported the boundary through `src/index.ts`.
- Added focused fake-client tests for disabled behavior, redaction, tombstones, schema conventions, and unavailable-cloud handling.

Verification:

- `npm test` — 200 passing
- `npm run typecheck` — passed
- `git diff --check` — passed

No BigQuery SDK, ADC access, scheduler, watermark, retry, commit, or push was added; those remain outside task 0073.
