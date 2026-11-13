---
id: BL-0056
title: UI role read model and ADR 0031 polish
type: idea
status: open
created_at: 2026-11-13T11:42:00Z
source: IP-0008 T-0006 reviewer handoff
promoted_to: null
---

# BL-0056: UI role read model and ADR 0031 polish

## Description

Optional improvements found in the T-0006 review:

- Invalid role list entries use the raw file name as `id` without `redact()`. Apply `redact(entry.id)` to invalid entries so an owner-chosen file name can never put a secret-like string into UI data.
- `/api/ui-data` reads every valid role file three times and sends up to 16 KB of text per role, with no cap on the number of roles. Consider a cap or on-demand text loading if the SPA polls often or a home has many roles.
- Rename the reused `TaskWriteError` class to a neutral name such as `UiWriteError`.
- ADR 0031 wording: "Every surface reports only `invalid: secret-like text`" is loose (the UI says `Cannot equip role: secret-like text`; status lines use `(invalid: <reason>)`). Optionally quote the UI-only messages `Invalid role id.`, `Role not found.`, `Start the agent once before managing roles from the UI.`, and `Role write failed.`

## Context and evidence

- [T-0006 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0006--role-adr-and-ui-routes/handoffs/20261113_114101--reviewer-handoff-1.md), Follow-ups.

## Discussion

- None yet.

## Open questions

- None
