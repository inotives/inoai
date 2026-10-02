---
id: task-0033
title: "Phase 5: Prompt context and shared Memory"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-01
priority: high
parent: ""
depends_on:
  - task-0032
message: Independent re-review clean after secret and budget fixes; 76 tests and
  full checks passed
---







# Task

## Context

The worker now reaches Codex, but the proposal requires a compact quote when a user replies to an earlier Message and locally ranked active shared Memory within a 6,000-character budget. Archived history is not itself durable Memory.

## Goal

Supply bounded, provenance-clear context for each turn without rewinding the Agent Session or leaking unrelated history.

## Scope

- Resolve `reply_to_external_message_id` against the Conversation archive at processing time. Include a compact clearly quoted reference to the earlier Message in the prompt; if the target is unavailable, preserve the user's new Message without inventing quote content.
- Rank active Agent Instance Memory locally against the current Message and include only relevant items within the existing 6,000-character context budget. Exclude soft-deleted Memory and secret-like material; label Memory as context rather than user instruction.
- Preserve the original user Message and reply reference in SQLite. Do not inject raw full transcript history or create Memory from chat.
- Add focused tests for out-of-order reply timing, missing target, ranking/budget cutoff, and no unrelated/deleted Memory.

## Planner Notes

Dependency gate: task-0032 must pass independent review. Prefer a small deterministic local relevance rule; do not add a search service, embedding dependency, or speculative retrieval layer.

## Implementation Plan

1. Compose prompt context at the worker boundary using existing archive/Memory APIs.
2. Test quote and Memory boundaries, then run full checks.

## Acceptance Criteria

- [ ] A late reply to an older archived Message reaches Codex with a compact quote while the same Agent Session continues in FIFO order.
- [ ] Missing reply targets add no invented text, and archived user input remains unchanged.
- [ ] Only relevant active shared Memory is injected, clearly labeled and capped at 6,000 characters; deleted/irrelevant entries and raw history are excluded.

## Notes
