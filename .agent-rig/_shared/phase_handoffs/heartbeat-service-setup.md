# Heartbeat Service Setup Phase Handoff

Status: complete
Branch: `phase/heartbeat-service-setup`

## Outcome

Implemented the planner-managed `heartbeat setup --connect-dir <runtime>` flow.
It performs preflight before mutation, reconciles the exact LaunchAgent target transactionally, activates the service, verifies the supervisor, child, and lock ownership within 10 seconds, and rolls back failed changes.

Existing low-level `heartbeat launchagent` commands remain compatible. Setup is explicit-target, idempotent, always enables load/recovery, does not build or install dependencies, and emits sanitized human-readable errors.

## Task evidence

- `task-0139` through `task-0143` are complete with approved reviewer handoffs.
- Heartbeat tests: 46 passed.
- Typecheck, build, architecture check, and `git diff --check` passed.
- Full suite: 322 passed, 6 unrelated existing skill-catalog/migration failures, 1 skipped.
- Credential-pattern scan passed for the documentation diff.

## Remaining limitation

No real LaunchAgent activation was run. Live activation should be performed separately against an explicitly selected test runtime after review of the uncommitted diff.

## Publication

No commit or push was made.
