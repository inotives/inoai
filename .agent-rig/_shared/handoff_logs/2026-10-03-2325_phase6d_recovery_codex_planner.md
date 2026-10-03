---
agent: codex
role: planner
tool: codex
task: phase-6d-runtime-recovery
task_title: Codex runtime self-recovery and launchd fallback
status: done
---

# Runtime recovery planner handoff

## Outcome

Implemented in-process Codex recovery and an optional macOS launchd KeepAlive fallback. A timed-out or dead-server Turn remains uncertain and is never replayed. The runtime reconnects with bounded backoff, rebinds approval handling, and later queued Turns resume persisted Agent Sessions. launchd handles process crashes or machine restarts.

## Verification

- `npm test`: 210 passing
- `npm run typecheck`: passed
- `npm run build`: passed
- `git diff --check`: passed
- launchd plist lint and generated absolute-path inspection passed.
- Live launchctl KeepAlive testing was unavailable in this non-GUI environment and is documented as such.

## Follow-up

The runtime should be restarted after deployment to load the recovery changes. The original live BigQuery export was fixed for nullable query parameters; a fresh end-to-end export can be verified after the local retry backoff is cleared or expires.
