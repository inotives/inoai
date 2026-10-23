---
id: BL-0008
title: Task column migration reads columns outside its transaction
type: bug
status: open
created_at: 2026-10-23T14:31:00Z
source: IP-0002 T-0001 reviewer handoff 1
promoted_to: null
---

# BL-0008: Task column migration reads columns outside its transaction

## Description

`migrateTasks` in `src/inoai/connectors/persistence/sqlite/legacy-database.ts` reads `PRAGMA table_info(tasks)` before it takes `BEGIN IMMEDIATE`. If two writable `openDatabase` calls run on an old home at the same time, the second can fail with "duplicate column". The risk is low today because the Runtime Home Lock gives the runtime the only writable `openDatabase` path.

## Reproduction

- Steps to reproduce: open the same pre-IP-0002 home with two writable `openDatabase` calls at once (not possible through current entry points).
- Expected: both opens succeed; the columns are added once.
- Actual: the second open may fail with "duplicate column name".

## Context and evidence

- Source: IP-0002 T-0001 reviewer handoff 1 (`trinary-workspace/features/IP-0002--ui-task-management/tasks/T-0001--task-schema-and-schedules/handoffs/20261023_142955--reviewer-handoff-1.md`, local).
- Fix idea: re-read the column list inside the transaction.

## Discussion

None

## Open questions

- Does any planned feature add a second writable opener? If not, this may be dropped.
