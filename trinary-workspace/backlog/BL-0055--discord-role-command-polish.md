---
id: BL-0055
title: Discord role command polish
type: idea
status: open
created_at: 2026-11-13T11:30:00Z
source: IP-0008 T-0005 reviewer handoff
promoted_to: null
---

# BL-0055: Discord role command polish

## Description

Three optional improvements to the `/inoai role` commands:

- Add a test for the SQLITE_BUSY reply on a role command. The code path exists, but no test covers it.
- In `/inoai status`, a busy error from `roleStatusLine` falls through to the generic `Control unavailable. Please try again.` It could use the role-specific busy reply.
- If the equipped role's file is deleted, `/inoai role list` omits the equipped id, because the list is built from files. `status` and `show` do report it. Consider a line such as `<id> [equipped]: missing`.

## Context and evidence

- [T-0005 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0005--discord-role-commands/handoffs/20261113_112917--reviewer-handoff-1.md), Follow-ups.

## Discussion

- None yet.

## Open questions

- None
