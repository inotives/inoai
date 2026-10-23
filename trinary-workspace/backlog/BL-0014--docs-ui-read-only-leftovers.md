---
id: BL-0014
title: Update leftover docs that call the UI read-only
type: idea
status: open
created_at: 2026-10-23T16:20:00Z
source: IP-0002 T-0006 worker and reviewer handoffs
promoted_to: null
---

# BL-0014: Update leftover docs that call the UI read-only

## Description

IP-0002 ADR 0026 allows the UI to write Tasks. Documents outside the T-0006 list still say the UI is read-only or never writes SQLite, and some README text predates current behaviour.

- `docs/discord-codex-cli-harness-proposal.md:279`, `docs/postgres-local.md:100`, `docs/implementation-phases.md:340/357`, `src/ui/README.md` ("read-only API modules").
- README Core Model paragraph (~line 66) says to stop the core before Memory or allowlist commands, which contradicts ADR 0025.
- README (~line 276) calls `npm start -- ui` the "sibling Electron UI".
- Optional: cross-reference ADR 0026 "Run now" to `docs/sqlite-schema.md` "Task schedules".
- Low risk: `src/ui/api/read-model.ts:64` `redact()` does not list `DISCORD_TASK_CHANNEL_ID`.

## Context and evidence

- Source: IP-0002 T-0006 worker handoffs 1–2 and reviewer handoffs 1–2 (local workflow records).

## Discussion

None

## Open questions

- Update the archived and proposal documents, or add a pointer to ADR 0026?
