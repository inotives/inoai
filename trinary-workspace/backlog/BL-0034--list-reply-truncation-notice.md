---
id: BL-0034
title: Say when a Memory or Task list reply is cut
type: idea
status: open
created_at: 2026-10-30T23:49:00Z
source: IP-0006 T-0005 reviewer handoffs 1 and 2
promoted_to: null
---

# BL-0034: Say when a Memory or Task list reply is cut

## Description

`/inoai memory list` and the Task list reply stop at 1,900 characters. The cut is silent and can fall mid-line. Append a line such as "…and N more" when entries are left out.

## Context and evidence

- [T-0005 reviewer handoff 2](../features/IP-0006--memory-feedback-loop/tasks/T-0005--memory-slash-commands/handoffs/20261030_234822--reviewer-handoff-2.md), Follow-ups.
- `src/inoai/app.ts` Memory and Task list controls.

## Discussion

None

## Open questions

- None
