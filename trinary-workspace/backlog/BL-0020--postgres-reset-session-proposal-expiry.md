---
id: BL-0020
title: PostgreSQL resetSession does not expire Task proposals
type: idea
status: open
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

## Open questions

- Will Task proposals be supported on PostgreSQL?
