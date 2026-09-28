---
agent: reviewer
role: reviewer
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: handoff
---

# Re-review: task-0012 owner allowlist bootstrap

## Finding

### High: changing the configured owner leaves the prior owner active

`bootstrapOwner` only upserts the current configuration at `src/database.ts:288-296`. If the configured `DISCORD_OWNER_USER_ID` changes, the prior row is neither disabled nor soft-deleted. The database then has two active `owner` users in the configured Discord guild, so the former owner remains allowlisted. This violates the task goal that the configured owner is the sole active V1 User.

Reproduction after the current fix: bootstrap owner `first`, then bootstrap owner `second` for the same guild. Querying active owner users returns both `first` and `second`.

Fix: make `bootstrapOwner` ensure the configured Discord guild has exactly one active owner—the configured ID. Retire any other active owner record in that transport/workspace (prefer `state = 'disabled'` to preserve the audit row) in the same transaction, then add a focused configuration-change regression test.

## Verified

- The original soft-delete finding is fixed: `upsertUser` clears `deleted_at` and `deleted_by` on conflict, preserves the row ID, and the new reactivation regression test passes.
- `npm test -- --test-name-pattern='bootstraps|reactivates'`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.

Task 0012 needs one further fix and re-review.
