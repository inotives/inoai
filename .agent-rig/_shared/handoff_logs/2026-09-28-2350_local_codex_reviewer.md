---
agent: reviewer
role: reviewer
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Re-review: task-0012 owner allowlist bootstrap

No issues found.

`bootstrapOwner` atomically upserts/reactivates the configured Discord owner,
then disables every other active, non-deleted owner in that guild. The
configured row is excluded from the disable update. `upsertUser` clears the
soft-delete audit fields on conflict, preserving reactivation behavior.

Verified:

- `npm test -- --test-name-pattern='bootstrap (reactivates|disables)|configuration'` (24 passing)
- `npm run typecheck`
- `git diff --check`
