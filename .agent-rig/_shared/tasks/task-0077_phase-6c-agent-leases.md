---
id: task-0077
title: "Phase 6c: PostgreSQL Agent Instance leases and ownership"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-04
updated_on: 2026-10-04
priority: high
parent: ""
depends_on:
  - task-0073
  - task-0075
message: Independent review clean; lease lifecycle, expiry, ownership checks,
  bounded config, tests, typecheck, build, and diff checks passed.
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---





# Task

## Goal

Prevent one Agent Instance from running simultaneously on multiple machines while supporting bounded recovery.

## Scope

- Add PostgreSQL lease or advisory-lock acquisition keyed by `AGENT_INSTANCE_ID`.
- Refresh ownership while the process is live.
- Release ownership on clean shutdown.
- Recover expired ownership only after the documented grace period.
- Preserve the local runtime-home lock as a fast local guard.

## Acceptance Criteria

- [ ] A second process for the same Agent Instance is rejected safely.
- [ ] Different Agent Instances can run concurrently.
- [ ] Shutdown releases ownership.
- [ ] Expired ownership is recoverable without duplicate active workers.
- [ ] Lease failures do not expose connection details or credentials.
