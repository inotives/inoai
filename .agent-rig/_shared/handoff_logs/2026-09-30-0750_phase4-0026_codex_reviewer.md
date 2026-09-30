---
agent: reviewer
role: reviewer
tool: codex
task: task-0026
task_title: "Phase 4: Live Discord approval controls"
status: handoff
---

# Task 0026 re-review handoff

Not accepted yet. No implementation edits made; leave task in `review` for the planner to return to the worker.

## Finding

1. **High — raw command preview can persist and post literal credentials.** `src/approval-relay.ts:11-15,32-34,119-122` treats an arbitrary command as safe if it has only letters, digits, spaces, dots, slashes, underscores, or hyphens and lacks a short list of credential *names*. A command such as `echo sk-proj-abcdef` passes that predicate, so the literal value becomes the SQLite `summary`, archived message, and Discord approval content. The new test only rejects a `PASSWORD=` assignment, which the character whitelist rejects regardless of whether the value is secret. This violates task 0026's no-credentials interaction-payload requirement and the proposal's no-credentials SQLite rule. Do not use a keyword/character heuristic as proof that raw command text is non-secret; display only a demonstrably safe structured preview or decline when its safety cannot be established, then add a token-shaped literal regression case.

## Verified

- The command/file/network previews distinguish requests and are bounded; missing/unsafe preview requests are declined before posting.
- A failed final Discord edit retries, and `reconcileFinalControls()` re-edits finalized controls without a second Codex response. Owner, message, workspace, live request, expiry, and pending-row gates remain in place for the checked path.
- `npm test`: 58/58 pass; `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- No live Discord/app-server end-to-end test was run without owner bot credentials. Startup reconciliation remains task 0027's scope.
