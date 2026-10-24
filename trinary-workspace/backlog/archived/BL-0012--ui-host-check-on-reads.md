---
id: BL-0012
title: Check Host on UI page and read routes
type: idea
status: promoted
created_at: 2026-10-23T15:23:00Z
source: IP-0002 T-0004 reviewer handoff 1
promoted_to: IP-0004
---

# BL-0012: Check Host on UI page and read routes

## Description

The UI server checks Host and Origin on task writes, but GET `/` and `/api/ui-data` answer any Host. A DNS-rebinding page can read the page (including the per-launch write token) and the read model. It still cannot write, because writes require the server's own Host and Origin. Checking Host on the page and read routes would close this read exposure, which predates IP-0002.

## Context and evidence

- Source: IP-0002 T-0004 reviewer handoff 1; probe with Host `evil.example:<port>` returned the token.

## Discussion

- [2026-10-24] Recheck on `main` at `16b551c`: still open and wider than described. Any non-Task path with any method and any Host returns the app shell, which embeds the per-launch write token (`src/ui/server.ts:138`). `/api/ui-data` answers any method because it is handled before the method is read (`:122`).
- [2026-10-24] Delivered by IP-0004 on `chore/cleanups`; archived to `backlog/archived/`.

## Open questions

- Should a wrong Host on reads return 403 or 421?
