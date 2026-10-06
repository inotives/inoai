---
agent: reviewer
role: reviewer
tool: codex
task: task-0088
task_title: Runtime lock recovery integrated review
status: done
storage_status: migrated
migrated_to: sqlite
---

## Verdict

Approved. No findings.

## Review

- The runtime-home lock is a `0600` JSON record containing PID, macOS process
  start time, and a random release token.
- Startup-only recovery reclaims only a dead owner or a PID whose macOS start
  time no longer matches. Live owners remain protected, and unverifiable,
  legacy, and malformed locks fail closed.
- Self-process start-time fallback is cached, preventing repeated fallback
  estimates from misclassifying a live lock. Release is token-safe and cannot
  remove a successor lock.
- README.md, docs/postgres-local.md, CONTEXT.md, and ADR 0015 consistently
  describe the local lock as supplementary to the PostgreSQL cross-machine
  lease and document the conservative recovery policy.
- No credential-like values were found in the reviewed diff. Existing
  AgentRig SQLite migration changes are pre-existing integrated work and were
  not modified by this review.

## Verification

- `npm test` — 221 passing, 2 skipped.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/test/runtime-home.test.js` — 12 passing.
- `git diff --check` — passed.

Task is approved for `done`.
