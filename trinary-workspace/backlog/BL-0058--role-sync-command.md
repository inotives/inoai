---
id: BL-0058
title: inoai role sync to refresh an existing roles/ folder
type: idea
status: open
created_at: 2026-11-13T16:00:00Z
source: IP-0008 role catalog decision and T-0009 worker handoff
promoted_to: null
---

# BL-0058: inoai role sync to refresh an existing roles/ folder

## Description

The vendored awesome-copilot role catalog is copied only when a runtime home's `roles/` folder is first created. Existing homes, including homes made during IP-0008 development with the 3 old starter roles, get no catalog updates. Add `inoai role sync [--connect-dir]`: it copies catalog roles whose files are missing, never overwrites, and reports what it added. It could reuse the T-0010 converter output (`roleCatalog`).

## Context and evidence

- IP-0008 decision "Role catalog" (refresh only on creation; sync deferred to the backlog).
- [T-0009 worker handoff](../features/IP-0008--equippable-roles/tasks/T-0009--docs-and-live-check/handoffs/20261113_155820--worker-handoff-1.md), Follow-ups.

## Discussion

- None yet.

## Open questions

- Should sync also report roles in `roles/` that differ from the catalog version?
