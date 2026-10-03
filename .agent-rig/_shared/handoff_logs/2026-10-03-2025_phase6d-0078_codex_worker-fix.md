---
agent: worker
role: worker
tool: codex
task: task-0078
task_title: Codex runtime self-recovery after timeout or exit
status: review
---

## Summary

- Fixed the pre-start app-server failure path so a Session active-turn guard is released when `turn/start` rejects before returning a Turn ID; the uncertain request is still never replayed.
- Added an optional `CodexRuntime` server-change callback and wired production reconnects to rebind the Discord `ApprovalRelay`.
- Made `ApprovalRelay.bind()` detach old listeners and respond through the originating server, preventing approvals on a replacement server from hanging or replying through a stale connection.
- Added deterministic fake-server tests for pre-Turn-ID death/recovery and replacement-server approval denial.

## Verification

- `npm test` — 210 passing
- `npm run typecheck` — passed
- `npm run build` — passed through `npm test`
- `git diff --check` — passed

## Reviewer findings addressed

- Pre-start `turn/start` rejection now records the failure and clears the guard when no Turn ID exists, allowing the next queued turn to resume after bounded reconnect.
- Replacement app-server approval requests are handled by the same fail-closed relay; the old server listener is detached during rebind.

No commit or push performed.
