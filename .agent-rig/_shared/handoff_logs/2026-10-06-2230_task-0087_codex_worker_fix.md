---
agent: worker
role: worker
tool: codex
task: task-0087
task_title: Runtime lock documentation and acceptance checks
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T22:30:00+08:00
---

## Fix

- Stabilized the cached macOS self-process start-time lookup in
  `src/runtime-home.ts`.
- When the native `ps` lookup falls back to the Node uptime estimate, the
  estimate is now reused for the process lifetime instead of being regenerated
  with a different millisecond value on each lock inspection.
- This prevents a live lock from being misclassified as stale, which could
  incorrectly reclaim the lock and allow a successor to start.
- Added a focused assertion that the lock record start time remains identical
  across repeated self-process lookups.

## Verification

- `npm test` — 221 passing, 2 skipped.
- `node --test dist/test/runtime-home.test.js` repeated 5 times — passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

No commit or push was performed. Ready for independent review.
