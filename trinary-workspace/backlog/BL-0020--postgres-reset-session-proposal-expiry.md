---
id: BL-0020
title: PostgreSQL resetSession does not expire Task proposals
type: idea
status: dropped
created_at: 2026-10-24T07:50:30Z
source: IP-0004 T-0001 worker handoff 1
promoted_to: null
---

# BL-0020: PostgreSQL resetSession does not expire Task proposals

## Description

The PostgreSQL adapter's `resetSession` (`src/inoai/persistence/operational-store.ts:310`) ignores the optional `now` added in IP-0004 T-0001 and does not expire Task proposals. PostgreSQL has no task-proposal support today, so this is not a live bug. If proposals reach PostgreSQL later, its reset should expire them with the caller's clock.

## Context and evidence

- Source: IP-0004 T-0001 worker handoff 1 (local workflow record).

## Discussion

None
- [2026-10-30] IP-0005 T-0003 reviewer: the PostgreSQL adapter also does not implement `recoverTaskRuns`, which now returns the recovered runs so startup can write their result.md. Add both if PostgreSQL ever runs Tasks.
- [2026-10-30] IP-0006 adds SQLite-only Memory kinds, `memory_proposals`, and `memory_uses`. The PostgreSQL store treats every Memory as `topic` and has no proposals or usage records.

- [2026-11-12] Dropped in a backlog recheck on `main` at `fa15492`, at the owner's request to archive items that are fixed or no longer relevant. `PostgresOperationalStore` is used only by `src/test/postgres.integration.test.ts`; the runtime is SQLite-only. The only planned PostgreSQL work is Phase 6c (`docs/implementation-phases.md`): a future one-way, redacted SQLite-to-PostgreSQL reporting and backup sink. That sink would not run Task proposals, Task runs, or Memory proposals, so operational-store parity is not needed. Reopen as a new item if PostgreSQL ever becomes an operational store again.

## Open questions

None
