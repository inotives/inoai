---
id: BL-0022
title: Shared test wait helper and remaining lock-only shutdown waits
type: idea
status: open
created_at: 2026-10-24T08:14:30Z
source: IP-0004 T-0003 worker handoff 1
promoted_to: null
---

# BL-0022: Shared test wait helper and remaining lock-only shutdown waits

## Description

- Several test files define their own deadline `until`/`waitFor` helper (`approval-relay`, `memory-review`, `memory-review-scheduler`, `task-scheduler`, `task-proposal-cards`, `task-run-executor`, `conversation-worker`, `task-controls`, `opencode-runtime`, `runtime-review`). One shared test helper would reduce duplication.
- `transport.test.ts` loops at about `:1003-1011` and `:1085-1092` wait only for the lock file. Shutdown in `src/inoai/app.ts` (about `:766-770`) releases the lock before it sets `process.exitCode`, so an exit-code check after a lock-only wait can race. T-0003 fixed the same ordering at `:560` and `:836`. The remaining sites have not failed in any run.

## Context and evidence

- Source: IP-0004 T-0003 worker handoff 1 (local workflow record). The `:836` site failed 2 of 24 stress runs before its exit-code wait was added.

## Discussion

- [2026-10-24] IP-0004 T-0003 reviewer handoff 1 adds: the "cancel before init" wait in `claude-runtime.test.ts:476` is a bounded `for` loop (200 × 10 ms) that falls through silently; and `calls()` in the fake CLIs parses append-only JSONL, so a read overlapping an append could in theory see a partial line (never observed in 60+ stressed runs).
- [2026-10-30] IP-0005 T-0003 reviewer: the startup-recovery symlink test in `runtime-home.test.ts` does not assert the `Task Run #<id> result.md write failed` log line; optional test hardening.

## Open questions

None
