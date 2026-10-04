---
agent: codex
role: reviewer
tool: codex
task: task-0079
task_title: "Phase 6c: PostgreSQL Docker integration and acceptance"
status: blocked
---

## Re-review result

Not approved yet. The runtime-role and privilege assertions requested in the
previous review are now present, but the shutdown assertion still has a
resource-lifecycle defect.

## Verified fixes

- The opt-in test requires `POSTGRES_INTEGRATION_RUNTIME_URL` when enabled.
- It asserts `current_user = inoai_sync` for the runtime pool.
- Runtime DML is exercised through both operational stores.
- Runtime `CREATE TABLE` is required to fail with a privilege error.
- Lease release is queried through the migration/admin pool and both owner
  tokens must be null.
- The opt-in command remains skipped when no integration URL is supplied.
- Documentation describes the restricted runtime role and opt-in setup without
  exposing credentials.

## Blocking finding

`PostgresOperationalStore.close()` ends the injected shared `Pool`. The test
creates `storeOne` and `storeTwo` over the same runtime pool, then does:

1. `await storeOne.close()`;
2. `stores.length = 0` without closing `storeTwo`;
3. asserts the runtime pool is ended; and
4. the finalizer skips `storeTwo` because the array was cleared.

This leaks the second store's lifecycle and makes the shutdown check depend on
closing only one of two owners of the same pool. Fix the test/store ownership
boundary so every created store is explicitly closed exactly once, and verify
pool shutdown separately (for example, close both stores or use one dedicated
store for the pool-close assertion). Keep the lease-release assertion intact.

## Checks

- `npm test`: 213 passed, 0 failed, 2 skipped.
- `npm run typecheck`: passed.
- `npm run postgres:integration` without a URL: intentional skip.
- Docker-backed positive integration remains unverified because no local
  Docker-compatible daemon is available.
