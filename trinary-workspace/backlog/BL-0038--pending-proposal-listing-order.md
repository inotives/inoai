---
id: BL-0038
title: Pending proposal listing order in the review prompt
type: idea
status: open
created_at: 2026-10-31T01:12:30Z
source: IP-0006 T-0009 reviewer handoff 1
promoted_to: null
---

# BL-0038: Pending proposal listing order in the review prompt

## Description

The review prompt lists pending Memory proposals oldest first within a 3,000-character budget. With a large backlog of long unanswered proposals, the newest proposal can be left out. The newest is the one a later Session in the same cycle is most likely to repeat. Consider listing the newest first, and flattening newlines in proposal bodies.

## Context and evidence

- [T-0009 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0009--pending-proposals-in-review-prompt/handoffs/20261031_011133--reviewer-handoff-1.md), Follow-ups.
- `pendingProposalLines` in `src/inoai/memory/memory-review.ts`.

## Discussion

None

## Open questions

- None
