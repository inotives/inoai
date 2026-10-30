---
id: BL-0027
title: Task carryover text polish
type: idea
status: open
created_at: 2026-10-30T16:52:00Z
source: IP-0005 T-0004 reviewer handoff 1
promoted_to: null
---

# BL-0027: Task carryover text polish

## Description

Small follow-ups in the provider-switch carryover (`src/inoai/conversation/task-run-executor.ts`):

- The carryover header says "continues in a fresh agent session" (about line 222). A retried switched run that failed after `startAgentSession` resumes the bound session instead.
- `readRunAnswer` finds the answer by the first `\n\n## Answer\n\n` (about lines 330-334). An owner goal or expected output containing that line adds earlier `result.md` text to the carryover. Search after the `## Expected output` block.
- `slice` counts UTF-16 code units, so the 4,000/8,000 caps can split a surrogate pair (about line 334 and `keepNewest`).

## Context and evidence

- IP-0005 T-0004 reviewer handoff 1 (local workflow record). None affects read safety.

## Discussion

None

## Open questions

None
