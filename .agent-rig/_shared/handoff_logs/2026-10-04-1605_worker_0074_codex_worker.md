---
agent: worker_0074
role: worker
tool: codex
task: task-0074
task_title: "Phase 6c: per-Agent operational schema and restricted grants"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

## Completed

- Added migration `0003_agent_operational_schema.sql` with a privileged `inoai_control.provision_agent_schema(text)` function.
- The provisioning function creates the Agent Schema's users, sessions, messages, approvals, memory_reviews, memories, and events tables with PostgreSQL-native identity keys, audit fields, soft-delete checks, foreign keys, state constraints, unique constraints, queue/review/session indexes, and updated-timestamp indexes.
- Added runtime grants for `inoai_sync`: schema usage, table `SELECT`/`INSERT`/`UPDATE`, and sequence usage; no runtime DDL grants are issued.
- Added control-schema DML grants for `inoai_sync`.
- Updated the provisioning SQL factory to invoke the migration-installed function for every provisioned Agent Schema, and added a regression assertion for that output.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/test/postgres-provision.test.js dist/test/postgres-migrations.test.js` — 6 passed.
- `git diff --check` — passed.
- No live database mutation or credential access was performed.

## Reviewer notes

- Provisioning must run after migrations `0001`–`0003` with a privileged DBeaver/migration role; `inoai_sync` cannot install or alter the function/schema.
- The accepted architecture uses one shared `inoai_sync` login role. Cross-Agent isolation is therefore application-enforced by validated Agent Schema selection; database-enforced mode is reserved and rejected.
