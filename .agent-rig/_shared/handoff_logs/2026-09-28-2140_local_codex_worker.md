---
agent: worker
role: worker
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: done
---

# Owner bootstrap soft-delete repair complete

- `upsertUser` now clears `deleted_at` and `deleted_by` on a conflicting user key, so `bootstrapOwner` reactivates the configured owner while preserving its row ID.
- Added a focused regression test that soft-deletes the configured owner, bootstraps again, and confirms exactly one active owner with the original ID.

Verified:

- `npm test` — 23 passing
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Review scope: `src/database.ts`, `src/test/database.test.ts`, and this task state update. No commit or push was made.
