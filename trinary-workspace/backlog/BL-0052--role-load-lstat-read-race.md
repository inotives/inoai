---
id: BL-0052
title: Close the lstat-then-read race in loadRole
type: idea
status: open
created_at: 2026-11-13T09:18:16Z
source: IP-0008 T-0001 reviewer handoff
promoted_to: null
---

# BL-0052: Close the lstat-then-read race in loadRole

## Description

`loadRole` checks the file with `lstat` and then calls `readFile`, which follows symlinks. A file swapped for a symlink between the two calls would be read. The risk is low: `roles/` is owner-only (`0o700`), and the text is still validated, including the secret check. Opening with `O_NOFOLLOW` and then calling `fstat` on the handle would close the window. Consider this if role files ever come from a less trusted source.

## Context and evidence

- [T-0001 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0001--role-files/handoffs/20261113_091736--reviewer-handoff-1.md), Follow-ups.

## Discussion

- 2026-11-13: The T-0008 reviewer noted that the UI read model now uses `loadRole` too, so the same window applies there. Hardening `loadRole` with `O_NOFOLLOW` on an opened handle would cover the runtime and the UI together.

## Open questions

- None
