---
id: BL-0016
title: Task block opener is quadratic on a fence run before a bare CR
type: bug
status: open
created_at: 2026-10-23T23:42:00Z
source: IP-0003 T-0003 reviewer handoff 3
promoted_to: null
---

# BL-0016: Task block opener is quadratic on a fence run before a bare CR

## Description

In `src/inoai/tasks/task-block.ts`, `openerPattern` ends with `(.*)$`. `.` does not match a mid-line `\r` or U+2028, so a line of N backticks or tildes followed by one of them backtracks in O(N²).

## Reproduction

- Steps to reproduce: call `extractTaskBlock("`".repeat(100000) + "\rx")`.
- Expected: returns in about 1 ms.
- Actual: about 0.93 s at 50k characters and 3.7 s at 100k.

## Context and evidence

- Source: IP-0003 T-0003 reviewer handoff 3 (local workflow record).
- Reaching it needs more than 50,000 fence characters in one agent answer. A user cannot paste that in one Discord message.
- Fix: change `(.*)$` to `([^]*)$` (measured 0.1 ms at 100k) and add a timing test with the input above.

## Discussion

None

## Open questions

None
