---
id: BL-0002
title: Claude full usage and per-turn cost on resumed turns
type: idea
status: open
created_at: 2026-10-23T07:15:05Z
source: T-0002 worker and reviewer handoffs
promoted_to: null
---

# BL-0002: Claude full usage and per-turn cost on resumed turns

## Description

Claude usage covers only the main agent loop, and cost is recorded only on new-session Turns because `total_cost_usd` is cumulative. The CLI's `modelUsage` and `model_usage_since_last_result` (internal, optional) may give full per-Turn tokens and cost. Also, a malformed `cache_creation_input_tokens` currently counts as 0 instead of omitting input.

## Context and evidence

- IP-0001 T-0002 (commit `5d2edca`). Evidence from the Claude CLI 2.1.309 bundle's schema text: `total_cost_usd` is "Cumulative estimated cost in USD for this query() call", and a resumed session continues from the saved total. The result `usage` is "MAIN AGENT LOOP ONLY", and the CLI recommends `modelUsage` for token and cost accounting.

## Discussion

- [2026-10-23] Captured from T-0002 follow-ups.

## Open questions

- Is `model_usage_since_last_result` stable enough to rely on?
