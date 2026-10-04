---
agent: worker_0077
role: worker
tool: codex
task: task-0077
task_title: "Phase 6c: PostgreSQL Agent Instance leases and ownership"
status: handoff
---

## Summary

- Added `migrations/0004_agent_instance_leases.sql` for the shared control-plane lease table and runtime grants.
- Added `src/postgres-lease.ts` with atomic acquisition, advisory serialization, configurable TTL/heartbeat refresh, expiry recovery, ownership-checked release, and sanitized failures.
- Added `POSTGRES_LEASE_TTL_MS` and `POSTGRES_LEASE_REFRESH_MS` configuration with bounded validation and documented same-machine/local-lock plus cross-machine/PostgreSQL-lease behavior.
- Added focused tests for timing validation, acquire/refresh/release, active-owner rejection and expiry recovery, and credential-free error handling.

## Isolation decision

The current `POSTGRES_ISOLATION_MODE=application` policy remains unchanged. Lease ownership is keyed by the validated `AGENT_INSTANCE_ID`; application wiring will acquire this lease after the local runtime-home lock in task 0078. The lease module does not bypass or replace `inoai.lock`.

## Verification

- `npm test` — 214 passing.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

No commit or push was performed.
