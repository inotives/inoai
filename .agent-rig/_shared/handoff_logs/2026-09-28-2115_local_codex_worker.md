---
agent: worker
role: worker
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Owner allowlist bootstrap ready for review

- Added `bootstrapOwner` in `src/database.ts`: it upserts the validated Discord owner for the configured guild as an active `owner`.
- `start` now opens the selected runtime database after acquiring its lock, bootstraps that owner, and closes the database before releasing the lock.
- Added restart/idempotency coverage in `src/test/database.test.ts`; it verifies one active owner row and a stable row ID after reopening the database.

Verified:

- `npm test -- --test-name-pattern='configured owner|startup bootstraps'` — 22 passing
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Review scope: `src/database.ts`, `src/index.ts`, and `src/test/database.test.ts`, alongside prior uncommitted Phase 2 work.
