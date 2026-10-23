---
id: BL-0012
title: Check Host on UI page and read routes
type: idea
status: open
created_at: 2026-10-23T15:23:00Z
source: IP-0002 T-0004 reviewer handoff 1
promoted_to: null
---

# BL-0012: Check Host on UI page and read routes

## Description

The UI server checks Host and Origin on task writes, but GET `/` and `/api/ui-data` answer any Host. A DNS-rebinding page can read the page (including the per-launch write token) and the read model. It still cannot write, because writes require the server's own Host and Origin. Checking Host on the page and read routes would close this read exposure, which predates IP-0002.

## Context and evidence

- Source: IP-0002 T-0004 reviewer handoff 1; probe with Host `evil.example:<port>` returned the token.

## Discussion

None

## Open questions

- Should a wrong Host on reads return 403 or 421?
