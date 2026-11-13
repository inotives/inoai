---
id: BL-0049
title: Claude-only settings fail validation on other providers while API settings only warn
type: idea
status: open
created_at: 2026-11-13T02:24:45Z
source: IP-0007 live check
promoted_to: null
---

# BL-0049: Claude-only settings fail validation on other providers while API settings only warn

## Description

On a home that is not `claude`, `CLAUDE_ALLOWED_TOOLS` and `CLAUDE_PROMPT_CACHE_TTL` fail validation. On a home that is not `anthropic-api`, `ANTHROPIC_API_*` settings are ignored with a warning (IP-0007 decision R1). Switching robin from `claude` to `anthropic-api` therefore needed the `CLAUDE_*` lines commented out first. Consider making provider-specific settings consistently warn-and-ignore, so switching a provider is a one-line change.

## Context and evidence

- IP-0007 live check, 2026-11-13: `validate` reported "CLAUDE_ALLOWED_TOOLS is only supported when AGENT_PROVIDER is claude".
- RF-0002 added the `CLAUDE_PROMPT_CACHE_TTL` rule; `CLAUDE_ALLOWED_TOOLS` already had it.

## Discussion

- None yet.

## Open questions

- Should a stray Claude setting keep failing for safety (for example `CLAUDE_ALLOWED_TOOLS`), or warn like R1?
