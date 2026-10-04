---
agent: reviewer_0077
role: reviewer
tool: codex
task: task-0077
task_title: "Phase 6c: PostgreSQL Agent Instance leases and ownership"
status: done
---

## Review result

No blocking findings.

The implementation uses a transaction-scoped PostgreSQL advisory lock keyed by the normalized Agent Instance ID, then atomically inserts or replaces only an expired lease row. Active owners are rejected, and the owner token condition prevents a stale refresh or release from affecting a successor. TTL and heartbeat intervals are bounded by configuration, refresh failures are fail-closed for the lease object, and lease errors do not include PostgreSQL connection details. The runtime-home lock remains a separate local guard.

The focused tests cover timing validation, acquisition/refresh/release, active-owner rejection with expiry recovery, and credential-free errors. The recovery test is a mock-level contract test rather than a wall-clock PostgreSQL integration test; the SQL predicate (`expires_at <= now()`) and advisory serialization are the relevant production guarantees and should be covered by the phase-wide Docker integration task.

## Verification

- `npm test` — 214 passing
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Task may be marked done and the next eligible task may be selected.
