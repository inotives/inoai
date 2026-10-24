---
id: BL-0005
title: Recheck runtime usage mapping on CLI upgrades
type: idea
status: promoted
created_at: 2026-10-23T07:32:06Z
source: T-0002, T-0003, T-0004 reviewer handoffs
promoted_to: IP-0004
---

# BL-0005: Recheck runtime usage mapping on CLI upgrades

## Description

The token and cost mappings rely on version-specific CLI behaviour: Claude 2.1.309 result usage, Codex 0.163.0 thread totals, and OpenCode 2.0.26 minified internals. Add an upgrade checklist step that rechecks these meanings when a CLI version changes.

## Context and evidence

- T-0002, T-0003 and T-0004 reviewer handoffs.

## Discussion

- [2026-10-23] Captured from T-0004 follow-ups.
- [2026-10-24] Delivered by IP-0004 on `chore/cleanups`; archived to `backlog/archived/`.

## Open questions

- None
