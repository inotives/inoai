---
id: task-0035
title: "Phase 5: Progress and final response delivery"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0034
message: Independent review clean; 84 tests and full checks passed
---





# Task

## Context

The worker produces persisted outcomes, but Phase 5 must acknowledge work, show compact progress, and deliver completed responses to the source Discord thread. ADR 0005 favors no duplicate Discord chunks after an ambiguous send.

## Goal

Deliver one final answer or safe failure notice per turn, with durable chunk records and honest delivery state.

## Scope

- Acknowledge accepted/queued work promptly and periodically show a compact working indicator. Do not publish live partial assistant text, tool traces, or raw command output.
- Split only the completed final answer at safe transport boundaries. Persist each linked agent Message chunk before send, then confirm its Discord ID or record known failure/uncertainty.
- Do not automatically resend an ambiguous chunk after restart. Keep the complete response locally archived and expose safe delivery failure Events/state for inspection.
- Deliver one safe notice for terminal runtime failure or uncertain outcome. Avoid duplicate final answers, failure notices, and working indicators across retries/restarts where the outcome is ambiguous.
- Add fake-transport tests for long Unicode output, multiple chunks, partial send failure, crash after network acceptance, and no raw trace/secret leakage.

## Planner Notes

Dependency gate: task-0034 must pass independent review. Reuse the task-0031 durable delivery primitives. No automatic resend should be inferred from a missing Discord external ID.

## Implementation Plan

1. Implement bounded progress and chunked final delivery on top of persisted outcomes.
2. Exercise success/failure/crash paths with a fake transport; run full checks.

## Acceptance Criteria

- [ ] One completed final answer appears as linked archived chunks in order, each within transport limits and with confirmed Discord IDs when delivery succeeds.
- [ ] A known send failure and an ambiguous send are durably distinguishable; restart never auto-resends ambiguous output.
- [ ] Progress remains compact and no partial assistant text, raw tool output, secret, or duplicate final response is posted.

## Notes
