---
id: BL-0023
title: Remaining stale docs and Claude usage recheck
type: idea
status: open
created_at: 2026-10-24T08:26:30Z
source: IP-0004 T-0004 worker handoff 1
promoted_to: null
---

# BL-0023: Remaining stale docs and Claude usage recheck

## Description

Doc drift left outside IP-0004 T-0004 scope:

- `CONTEXT.md:68` — "Manual Memory Entry" says "local management CLI or Electron UI". The UI does not write Memory.
- `docs/adr/0014-postgresql-operational-source-of-truth.md:21,25` — Electron mentions.
- README "Repository Layout" tree is stale (for example, it lists `src/inoai/ui.ts`, which does not exist).
- `docs/repository-structure.md` "Initial repository structure" (`apps/core`, `apps/ui`) does not match the real `src/` layout.
- Optional BL-0014 item not done: cross-reference from ADR 0026 "Run now" to `docs/sqlite-schema.md` "Task schedules".
- `docs/archived/*` not checked for Electron mentions (historical; may stay).
- Installed Claude Code is 2.1.310; the usage mapping was last verified on 2.1.309. Run the README "Upgrading agent CLIs" Claude recheck.

## Context and evidence

- Source: IP-0004 T-0004 worker handoff 1 (local workflow record).

## Discussion

None

## Open questions

None
