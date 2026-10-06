---
agent: worker
role: worker
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Owner configuration-change repair complete

`bootstrapOwner` now runs atomically: it reactivates/upserts the configured Discord owner, then disables every other active owner in that guild. Soft-deleted configured owners still reactivate through `upsertUser`.

Added a regression test that changes the configured owner and asserts the old audit row remains disabled while the new owner is the sole active owner.

Verified with `npm test` (24 passing), `npm run typecheck`, `npm run build`, and `git diff --check`.
