---
agent: reviewer_0074
role: reviewer
tool: codex
task: task-0074
task_title: "Phase 6c: per-Agent operational schema and restricted grants"
status: blocked
---

## Review result

**Changes requested.** The migration correctly translates the documented tables and includes audit fields, soft-delete pair checks, foreign keys, state checks, uniqueness constraints, queue/review/session indexes, and restricted table/sequence grants. Typecheck, build, focused provisioning/migration tests, and `git diff --check` pass. Docker integration could not run because the local Docker daemon is unavailable.

## Blocking finding

The task acceptance criterion requires cross-Agent Schema access to be denied, but migration `0003_agent_operational_schema.sql` grants the shared `inoai_sync` role `SELECT, INSERT, UPDATE` on every table in each provisioned Agent Schema. PostgreSQL privileges are role-wide: once the same login role is granted access to two Agent Schemas, that login can directly access both schemas. The current implementation therefore cannot satisfy cross-Agent Schema isolation for multiple agents.

This conflicts with the accepted shared-role architecture, so the implementation needs an explicit resolution before the task can pass. The focused fix should either:

1. replace direct per-agent table grants with controlled `SECURITY DEFINER` APIs that enforce the active Agent Instance and revoke direct table access; or
2. revise the acceptance/design to state that schema boundaries are organizational only under the shared role, with application-level ownership enforcement and tests proving no cross-agent access through the operational-store API.

Do not unlock task 0075 until this is resolved and independently re-reviewed. The worker handoff already called out this same trade-off.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/test/postgres-provision.test.js dist/test/postgres-migrations.test.js` — 6 passed.
- `git diff --check` — passed.
- Docker integration was not run: Docker daemon unavailable.
