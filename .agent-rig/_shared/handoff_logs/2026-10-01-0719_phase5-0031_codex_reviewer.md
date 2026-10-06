---
agent: reviewer
role: reviewer
tool: codex
task: task-0031
task_title: "Phase 5: Durable turn and delivery state"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0031 independent review

## Finding

- High — Reset is not a complete queue boundary for a concurrent late inbound Message. `resetSession` ends the Session and fails rows already queued (`src/database.ts:586-599`), but `archiveMessage` still inserts a new pending user row for that ended Session (`src/database.ts:474-486`), and `claimNextMessage` selects it without checking Session state (`src/database.ts:497-515`). Reproduced with a disposable runtime home: after `resetSession` returned `true`, `archiveMessage` returned `inserted=true`, and `claimNextMessage` returned that row while the Session state remained `ended`. A gateway handler holding a stale Session reference could therefore run a post-reset turn on the old Agent Session. Guard the insertion/claim boundary transactionally and add a late-inbound-after-reset regression test. Preserve the archived failure if the incoming row must be retained for audit.

## Verification

- `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Migration code and tests preserve legacy Message IDs and approval references; `PRAGMA foreign_key_check` is covered. Pre-runtime versus post-runtime recovery and pending/uncertain/confirmed/failed chunk transitions are covered. No other blocking issue found in the reviewed scope.
- No implementation edits, commit, or push. Task remains in `review` for planner disposition.
