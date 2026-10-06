---
agent: worker_0073
role: worker
tool: codex
task: task-0073
task_title: "Phase 6c: shared control schema and Agent Instance provisioning factory"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

## Completed

- Added `migrations/0002_control_agents.sql` with the shared `inoai_control.agent_instances` registration table, owner metadata, provider/runtime-home fields, safe identity checks, timestamps, disabled marker, and owner index.
- Added `src/agent-identity.ts` for strict lowercase `agent-...` validation and safe underscore-form Agent Schema derivation.
- Added `src/postgres-provision.ts` and `npm run postgres:provision` to emit deterministic, reviewable DBeaver SQL. It sorts multiple inputs, rejects duplicate normalized IDs and schemas, quotes SQL literals, and never accepts or emits a database URL/credential.
- Added tests for the current planner identity, a future agent slug, deterministic output, duplicate rejection, unsafe IDs, missing values, provider validation, and credential-free output.
- Task status set to `review`.

## Verification

- `npm run build` — passed.
- `node --test dist/test/postgres-provision.test.js` — 3 passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- `npm test` — existing unrelated failure in `dist/test/bigquery.test.js`: missing `@google-cloud/bigquery`; 201 tests passed and 1 test file failed before this task's tests were evaluated. No BigQuery files were changed by this task.

## Notes for reviewer

- This task intentionally does not create operational tables or runtime grants; those belong to task-0074.
- The provisioning script creates the per-Agent schema shell and inserts registration metadata. Duplicate registrations are deliberately plain `INSERT` failures so an operator must review/resolve collisions rather than silently overwrite ownership.
- No live PostgreSQL mutation or credential access was performed.
