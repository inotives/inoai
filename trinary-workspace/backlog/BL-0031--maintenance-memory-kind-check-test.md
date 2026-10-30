---
id: BL-0031
title: Test the maintenance refusal for a missing memories.kind
type: idea
status: open
created_at: 2026-10-30T23:10:33Z
source: IP-0006 T-0001 reviewer handoff 1
promoted_to: null
---

# BL-0031: Test the maintenance refusal for a missing memories.kind

## Description

`validateMaintenanceDatabase` refuses a live database whose `memories` table has no `kind` column. No test covers this refusal. It mirrors the tested `messages.delivery_state` check. Add a focused test.

## Context and evidence

- [T-0001 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0001--memory-schema-and-store/handoffs/20261030_230959--reviewer-handoff-1.md), Follow-ups.
- Also noted in [T-0001 worker handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0001--memory-schema-and-store/handoffs/20261030_230633--worker-handoff-1.md), Remaining concerns.

## Discussion

None

## Open questions

- None
