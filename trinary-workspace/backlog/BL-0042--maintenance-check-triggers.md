---
id: BL-0042
title: Maintenance schema check does not verify triggers
type: idea
status: open
created_at: 2026-11-12T16:50:00Z
source: IP-0007 T-0002 reviewer handoff
promoted_to: null
---

# BL-0042: Maintenance schema check does not verify triggers

## Description

`validateMaintenanceDatabase` checks that the required tables and indexes exist, but not the append-only triggers on `memory_uses`, `agent_history_sessions`, and `agent_history`. The risk is low, because `initialSchema` always creates the triggers with their tables.

## Context and evidence

- IP-0007 T-0002 reviewer handoff (follow-ups), 2026-11-12.
- `src/inoai/connectors/persistence/sqlite/legacy-database.ts`, `validateMaintenanceDatabase`.

## Discussion

- None yet.

## Open questions

- Is a trigger check worth the extra schema coupling?
