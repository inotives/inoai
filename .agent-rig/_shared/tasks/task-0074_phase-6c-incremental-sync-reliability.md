---
id: task-0074
title: "Phase 6c: Incremental sync reliability"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0073
message: "Approved by independent review. Watermarks, overlap/idempotency,
  bounded retry/backoff, non-secret events, recursion exclusion, scheduler
  cadence/stop, and disabled failure containment verified. 203 tests, typecheck,
  build, diff check pass. Handoff:
  2026-10-03-1900_phase6c-0074_codex_reviewer.md"
---





# Task

## Goal

Make recurring export incremental, retry-safe, and operationally independent from chat.

## Scope

- Persist per-table sync watermarks locally in SQLite.
- Support the configured interval (hourly initial default) without hard-coding the cadence.
- Use an overlap/idempotency strategy for equal timestamps and retries.
- Record non-secret success/failure/deferred events locally.
- Retry later with bounded backoff; never delay Turns, queue claims, or Memory Reviews.
- Preserve cursor/state when the process stops or BigQuery is unavailable.

## Acceptance Criteria

- [ ] Only new/changed rows are selected after a successful watermark.
- [ ] A failed attempt can retry without duplicates or data loss.
- [ ] Cloud outage leaves core behavior usable.
- [ ] Scheduler and restart tests pass.
