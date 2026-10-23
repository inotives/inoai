---
id: BL-0004
title: Codex usage for the first turn after restart
type: idea
status: open
created_at: 2026-10-23T07:23:50Z
source: T-0003 worker and reviewer handoffs
promoted_to: null
---

# BL-0004: Codex usage for the first turn after restart

## Description

Codex reports only thread running totals, so the first turn of a resumed thread after an inoai restart, and a turn after one that ended early, record no usage. `rawResponse/completed` carries per-response usage but is marked internal-only in Codex 0.163.0. Revisit if Codex exposes per-turn usage or the total on resume. Optional test hardening: a failed or cancelled turn that received usage updates.

## Context and evidence

- T-0003 worker and reviewer handoffs.

## Discussion

- [2026-10-23] Captured from T-0003 follow-ups.

## Open questions

- None
