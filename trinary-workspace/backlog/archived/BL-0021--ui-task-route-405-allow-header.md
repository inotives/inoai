---
id: BL-0021
title: UI Task route 405 replies lack an Allow header
type: idea
status: promoted
created_at: 2026-10-24T08:00:30Z
source: IP-0004 T-0002 reviewer handoff 1
promoted_to: IP-0005
---

# BL-0021: UI Task route 405 replies lack an Allow header

## Description

405 replies from `taskRoute` in `src/ui/server.ts` (for example, GET `/api/tasks`) have no `Allow` header. The page and data routes set one since IP-0004 T-0002. This predates T-0002 and has no user impact.

## Context and evidence

- Source: IP-0004 T-0002 reviewer handoff 1 (local workflow record).

## Discussion

- [2026-10-30] Promoted to IP-0005 (Task run reliability) on branch `feat/task-run-reliability`. The feature README is canonical from now on.

## Open questions

None
