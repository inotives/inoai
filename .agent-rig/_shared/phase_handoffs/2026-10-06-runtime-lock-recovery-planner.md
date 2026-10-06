---
agent: planner
role: planner
tool: codex
task: runtime-lock-recovery
task_title: Runtime-home lock stale recovery
status: done
---

# Runtime-lock recovery phase handoff

## Outcome

Implemented crash-recoverable runtime-home locks for the macOS V1 target.
`inoai.lock` now records JSON PID, process start time, and a random release
token. Startup reclaims only dead or PID/start-time-mismatched owners. Live
owners remain protected; legacy, malformed, or unverifiable locks fail closed.
The PostgreSQL Agent Instance lease remains the cross-machine authority.

## AgentRig tasks

- `task-0085` foundation: done after independent review.
- `task-0086` startup recovery and regression coverage: done after independent review.
- `task-0087` documentation and acceptance checks: done after a fix/re-review for the cached self-process start-time race.
- `task-0088` final integrated review: approved.

## Verification

- `npm test`: 221 passing, 2 skipped
- Focused runtime-home tests: 12 passing
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- No credentials exposed in the diff.

## Review finding resolved

The first review found that recalculating the macOS self-process start-time
fallback made a live lock appear stale during concurrent release testing. The
worker cached that fallback for the process lifetime and added regression
coverage; repeated runtime-home tests and final review passed.
