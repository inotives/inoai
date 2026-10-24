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

- [2026-10-24] IP-0004 T-0005 (README restructure) takes the README layout tree, the `docs/repository-structure.md` trees, and `CONTEXT.md:68`. The other items stay here.
- [2026-10-24] IP-0004 T-0005 worker follow-ups: the `INSTRUCTIONS.md` Heartbeat "Isolated acceptance checks" command names test paths that do not exist (heartbeat tests are in `dist/inoai/test/heartbeat/`); `src/platform/README.md` and `src/persistence/README.md` describe removed files; `npm test` globs `dist/platform/*.test.js`, which matches nothing; the deployment tree lists `backups/`, which nothing creates.
- [2026-10-24] IP-0004 T-0005 reviewer: `docs/adr/0009-opencode-uses-its-configured-provider.md:3` says the README documents the OpenCode data flow; it now lives in `INSTRUCTIONS.md#opencode`.

## Open questions

None
