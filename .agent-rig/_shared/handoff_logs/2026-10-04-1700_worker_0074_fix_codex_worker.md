---
agent: worker_0074
role: worker
tool: codex
task: task-0074
task_title: "Phase 6c: per-Agent operational schema and restricted grants"
status: handoff
---

## Fix completed

- Resolved the reviewer finding using the owner's chosen shared-role policy: `POSTGRES_ISOLATION_MODE=application` is now the explicit current mode.
- Configuration defaults to `application` when omitted and rejects `database` (and all other values) fail-closed because database-enforced isolation is not implemented.
- Updated the ADR, task acceptance text, migration comments, and worker handoff to state that schema ownership/isolation is enforced by the application through validated Agent Instance and derived Agent Schema selection.
- Preserved schema-scoped `inoai_sync` DML grants and the existing strict Agent Instance slug/schema derivation.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/test/config.test.js dist/test/postgres-provision.test.js dist/test/postgres-migrations.test.js` — 18 passed.
- `git diff --check` — passed.

## Review boundary

No SECURITY DEFINER APIs or per-Agent database roles were added. PostgreSQL role-wide access remains an intentional consequence of the shared `inoai_sync` design; application operations must validate and use only the configured Agent Schema.
