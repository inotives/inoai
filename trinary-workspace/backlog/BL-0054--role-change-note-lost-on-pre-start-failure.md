---
id: BL-0054
title: Role change note is lost when the runtime fails pre-start
type: idea
status: open
created_at: 2026-11-13T09:37:30Z
source: IP-0008 T-0003 reviewer handoff
promoted_to: null
---

# BL-0054: Role change note is lost when the runtime fails pre-start

## Description

`role_applied` is recorded at the point where the code treats the runtime as started: after `markRuntimeStarted` in chat, and before `runTurn` in Task Runs. A runtime failure of kind `pre_start` inside `runTurn`/`runRuntimeTurn` comes after that record, so the one-line "Role changed from X to Y." note is not repeated on the next Turn. The new role block still applies in the instructions. Options: record the role only after the first runtime event, or remove the record when the failure is `pre_start` and replay-safe.

## Context and evidence

- [T-0003 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0003--role-prompt-composition/handoffs/20261113_093652--reviewer-handoff-1.md), Follow-ups.

## Discussion

- None yet.

## Open questions

- Is the note important enough to keep when a switch coincides with a pre-start runtime failure?
