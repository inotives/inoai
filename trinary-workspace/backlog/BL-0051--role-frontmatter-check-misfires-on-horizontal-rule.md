---
id: BL-0051
title: Role frontmatter check misfires on a horizontal rule
type: bug
status: promoted
created_at: 2026-11-13T09:18:16Z
source: IP-0008 T-0001 reviewer handoff
promoted_to: IP-0008
---

# BL-0051: Role frontmatter check misfires on a horizontal rule

## Description

`validateRole` in `src/inoai/roles/role-file.ts` tests `/^---\s*$/m` on the first 200 characters. A `---` horizontal rule near the top of a role file, for example after a short summary, is rejected with the reason "frontmatter is not allowed". It still fails closed, but the reason misleads the owner. Real frontmatter always starts the file, and that case already fails the heading check. A `text.startsWith("---")` check would be enough.

## Reproduction

- Steps to reproduce: write a role file with `# Role: X`, a one-line summary, a `---` line, then valid `## Instructions` and `## Workflow` sections. Run `validateRole` on it.
- Expected: valid, or a reason that names the actual problem.
- Actual: `InvalidRoleError` with reason `frontmatter is not allowed`.

## Context and evidence

- [T-0001 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0001--role-files/handoffs/20261113_091736--reviewer-handoff-1.md), Follow-ups.

## Discussion

- 2026-11-13: Absorbed into IP-0008 by the role catalog change and fixed in T-0010: the frontmatter check is now `text.startsWith("---")`, with regression tests.

## Open questions

- None
