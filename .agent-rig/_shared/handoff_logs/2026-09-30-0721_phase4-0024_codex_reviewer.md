---
agent: reviewer
role: reviewer
tool: codex
task: task-0024
task_title: "Phase 4: Agent Session lifecycle and streaming"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0024 focused re-review

## Finding

- **Medium — cancel followed by early stream disposal can permanently lock a usable Session.** `cancel()` sends `turn/interrupt` (`src/codex-runtime.ts:105-110`), but the generator's `finally` sends a second interrupt (`src/codex-runtime.ts:84-95`) if the consumer closes before `turn/completed`. If Codex rejects that duplicate request, cleanup removes the notification listener and retains the active lock. A later terminal notice from the first, successful interrupt is then ignored, so all later turns fail with `Agent Session has an active turn`. Deterministic built-adapter probe: first interrupt accepted without immediate completion; second interrupt rejected; `return()` rejected with `second interrupt rejected`; terminal `turn/completed` then emitted; subsequent `runTurn()` still rejected as active; interrupt count was 2. This violates the cancellation-leaves-Session-usable acceptance criterion. Track an in-flight/sent interrupt so cleanup does not issue a duplicate, then wait for the matching terminal notice; preserve the fail-closed lock on genuine interrupt failure or process loss. Add this race as a regression test.

## Previous finding and checks

- The prior high-severity early-return overlap is fixed: early disposal waits for a matching terminal notice, and failed interrupt/process loss retain the lock rather than admit an overlapping turn.
- `npm test`: 55 pass, 0 fail. `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- Mapping, same project path, developer instructions, progress/final answer, and ordinary cancellation/process-loss acceptance remain covered. The new race is not covered by current tests.
- No implementation edits made. Leave task in `review` for planner to return to worker; do not unblock task 0025 yet.
