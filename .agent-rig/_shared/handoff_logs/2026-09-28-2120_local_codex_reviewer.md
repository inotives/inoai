---
agent: reviewer
role: reviewer
tool: codex
task: task-0012
task_title: "Phase 2: Owner allowlist bootstrap"
status: handoff
---

# Review: task-0012 owner allowlist bootstrap

## Findings

### High: a soft-deleted configured owner is not restored to the active allowlist

`bootstrapOwner` calls `upsertUser`, but the conflict update in `src/database.ts:279-281` restores `role` and `state` only. It leaves `deleted_at` and `deleted_by` populated. The follow-up lookup at `src/database.ts:284` filters `deleted_at IS NULL`, so `bootstrapOwner` returns `undefined` despite its `UserRecord` return type. Startup will therefore not establish the required active owner if that owner record was previously soft-deleted.

Reproduction: bootstrap the configured owner, run `UPDATE users SET deleted_at = unixepoch(), deleted_by = 'test' WHERE id = ?`, then call `bootstrapOwner` again. The existing row remains deleted and the returned value is `undefined`.

Fix: in the `ON CONFLICT ... DO UPDATE` clause, set `deleted_at = NULL, deleted_by = NULL` when bootstrapping/upserting the configured owner (or make that restoration explicit in `bootstrapOwner`), then add a focused test for reactivating a soft-deleted configured owner while retaining the single stable row ID.

## Verified

- The existing restart test passes: `npm test -- --test-name-pattern=bootstraps`.
- For a non-deleted owner, the implementation uses the correct Discord transport, configured guild and owner ID, active state, owner role, and unique user key.

Task 0012 should return to `ready` for the fix and re-review.
