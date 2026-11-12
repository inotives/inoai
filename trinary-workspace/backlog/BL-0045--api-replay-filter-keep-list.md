---
id: BL-0045
title: Keep-list replay filter before fallback blocks
type: idea
status: open
created_at: 2026-11-12T17:13:03Z
source: IP-0007 T-0004 reviewer handoff
promoted_to: null
---

# BL-0045: Keep-list replay filter before fallback blocks

## Description

The `anthropic-api` replay filter uses a deny-list (`thinking`, `redacted_thinking`, `tool_use`, unmatched `server_tool_use`) for content before the final `fallback` block. The API reference also says to leave out any other unrecognized model-internal block. A keep-list (`text`, `fallback`, paired server-tool use and result) would prevent a future block type from causing a 400 that sticks until `/inoai reset`.

Also add a test that a `pause_turn` continuation request after a row that already holds a `fallback` is filtered.

## Context and evidence

- IP-0007 T-0004 reviewer handoff (follow-ups), 2026-11-12.
- The claude-api reference, `model-migration.md`, "Echoing fallback turns back".

## Discussion

- [2026-11-12] The reviewer ruled the deny-list enough while only the pinned web tools are enabled. Do this when tools or betas are added.

## Open questions

- None
