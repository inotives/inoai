---
id: task-0065
title: "Phase 6: Engine-detected explicit memory requests for aggregation"
type: bug
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: Engine-detected explicit memory requests in aggregation; review clean,
  190 tests
---



# Task

## Context

The task-0063 live seeded Claude review (`.agent-rig/_shared/handoff_logs/2026-10-03-1245_phase6-0063_claude_worker.md`) completed safely but did not add the owner's "Please remember that I prefer pnpm…" Memory: the window step's notes kept the fact but dropped the explicit request, and the aggregation step (which sees only notes) chose `ignore`. inoai's own `hasMemorySignal` would have accepted it. Owner decision D3 (a): the engine passes deterministically detected explicit memory requests to the aggregation step.

Sources: Phase 6 in `docs/implementation-phases.md`, ADR 0010, `src/memory-review.ts`, task-0060 handoffs.

## Goal

Make the aggregation step see exactly the owner Messages the validator treats as explicit memory requests.

## Scope

- Before aggregation, select in-range owner Messages for which `hasMemorySignal` is true (same function the validator uses), redact them with `redactSecrets`, escape data tags, and include them in the aggregation prompt as a clearly labelled data section of explicit memory requests with their message IDs, within a fixed character budget (truncate per message and overall; record nothing extra).
- Update the fixed aggregation template so the model is told these are the owner's explicit requests and should be considered for `add`/`update` citing those IDs; transcript-as-data and JSON-only rules unchanged.
- Validation rules are unchanged (the model still proposes; inoai still verifies).
- Regression tests with a fake runtime: window notes that omit the request still yield an aggregation prompt containing the request ID/text; a quoted, agent-authored, negated, or question form is not listed; secret-like text in a request is redacted; the budget truncation works; an `add` citing a listed message is applied.
- Keep chat Turn behavior and other prompts unchanged.

## Planner Notes

After this passes review, re-run task-0063's live seeded review.

## Implementation Plan

1. Add candidate selection and the prompt section → verify: fake-runtime tests.
2. Full checks → verify: npm test, typecheck, build, diff checks.

## Acceptance Criteria

- [ ] The aggregation prompt lists exactly the validator-qualifying owner requests, redacted and bounded.
- [ ] A request dropped from window notes can still become Memory.
- [ ] No regressions in validation, redaction, or tag escaping.

## Notes

- 2026-10-03 worker (claude): Added `explicitRequests(included)` in `src/memory-review.ts`. It selects in-range owner entries passing the validator's own `hasMemorySignal` on the same redacted body, tag-escapes each, puts it on one line, cuts it to 500 chars (`requestChars`), and keeps lines in order within 4000 chars (`requestsBudget`, via `withinBudget`). The result goes into the aggregation prompt as `<explicit_requests>` (`[message N] text`, or `(none)`). The template now says these are explicit owner requests to consider for add/update citing their IDs, and lists `<explicit_requests>` among the data sections. `explicit_requests` was added to the closing-tag escape. Validation is unchanged. Added 3 regression tests and extended the tag-injection test. npm test 190/190; typecheck, build, and diff checks are clean. Handoff: `.agent-rig/_shared/handoff_logs/2026-10-03-1300_phase6-0065_claude_worker.md`.
