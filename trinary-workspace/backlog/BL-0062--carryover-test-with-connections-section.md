---
id: BL-0062
title: Test that Task carryover ignores the result.md Connections section
type: idea
status: open
created_at: 2026-11-14T00:30:00Z
source: IP-0009 T-0004 reviewer handoff 1
promoted_to: null
---

# BL-0062: Test that Task carryover ignores the result.md Connections section

## Description

T-0004 adds a `## Connections` section after `## Files` in a Task Run's `result.md`. `readRunAnswer` takes the text between `## Answer` and the last `## Files`, so carryover is unchanged. That is correct only by inspection. Add a focused test that `readRunAnswer` returns the same Answer when the section is present.

## Context and evidence

- [T-0004 reviewer handoff 1](../features/IP-0009--external-app-connections/tasks/T-0004--turn-wiring-and-status/handoffs/), Follow-ups.

## Discussion

- None yet.

## Open questions

- None
