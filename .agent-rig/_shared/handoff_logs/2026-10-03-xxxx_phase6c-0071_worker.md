---
agent: worker
role: worker
tool: codex
task: task-0071
task_title: "Phase 6c: Agent Instance metadata"
status: handoff
---

## Completed

- Added the singleton `agent_instance_metadata` table with audit and soft-delete columns.
- Added stable UUID generation on first database open and preserved it on subsequent opens.
- Added `getAgentInstanceMetadata` and optional metadata bootstrap inputs for provider/name.
- Wired normal application startup to persist the configured `AGENT_PROVIDER`; other database readers do not overwrite it.
- Defaulted `agent_name` to the runtime-home directory name and allowed a non-unique override through the database bootstrap options.
- Documented the local metadata table in `docs/sqlite-schema.md`.
- Added coverage for one-row bootstrap, restart stability, provider preservation, and independent IDs across two runtime homes.

## Verification

- `npm test` — 192 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

No BigQuery calls or credentials were added. Changes are uncommitted for the manager/reviewer workflow.
