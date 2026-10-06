---
agent: reviewer
role: reviewer
tool: codex
task: task-0087
task_title: Runtime lock documentation and acceptance checks
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T23:00:00+08:00
---

## Review result

No findings. The follow-up fix correctly caches the self-process start-time
fallback for the lifetime of the process, preventing a live lock from being
misclassified as stale when repeated `ps` lookups fall back to the Node uptime
estimate.

The implementation preserves the required safety behavior:

- dead process locks are reclaimable;
- live locks remain protected;
- PID/start-time mismatches are reclaimable;
- legacy and malformed locks fail closed;
- release remains token-safe and cannot remove a successor lock.

The README, PostgreSQL-local documentation, CONTEXT glossary, and ADR 0015
match the implemented startup-only recovery policy.

## Verification

- `npm test` — 221 passing, 2 skipped.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

Task is approved for `done`.
