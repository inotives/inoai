---
id: BL-0048
title: Claude CLI working folder may expose a runtime home's .env
type: bug
status: open
created_at: 2026-11-12T17:43:26Z
source: IP-0007 plan review and plan non-goal
promoted_to: null
---

# BL-0048: Claude CLI working folder may expose a runtime home's .env

## Description

The Claude CLI runs with its working folder set to `PROJECT_DIRECTORY`, or to the runtime home's parent folder when that is unset (`app.ts`). If a runtime home sits inside that folder, the CLI's read tools may be able to read `.inoai-connect*/.env`. That file holds `DISCORD_BOT_TOKEN` and may hold an `ANTHROPIC_API_KEY`. This exposure existed before IP-0007; IP-0007 listed fixing it as a non-goal and documented the risk in `INSTRUCTIONS.md`.

Also tidy the optional README:36 wording: state the no-permission-loosening promise for every CLI provider, including OpenCode (T-0007 reviewer nit).

## Reproduction

- Steps to reproduce: run a `claude` home with `PROJECT_DIRECTORY` unset, then ask the agent to read files in its working folder.
- Expected: runtime-home secrets are never readable by the agent.
- Actual (not yet confirmed): the CLI's read tools may reach `.inoai-connect*/.env`, depending on its permission policy.

## Context and evidence

- IP-0007 plan review finding 3, 2026-11-12.
- IP-0007 non-goals.
- `INSTRUCTIONS.md` Anthropic API section.

## Discussion

- None yet.

## Open questions

- Should startup refuse a working folder that contains the runtime home, or should it default to a folder that does not?
