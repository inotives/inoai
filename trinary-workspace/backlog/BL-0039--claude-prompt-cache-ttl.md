---
id: BL-0039
title: Opt-in 1-hour prompt cache for Claude Turns
type: idea
status: open
created_at: 2026-10-31T02:00:00Z
source: IP-0006 human acceptance discussion
promoted_to: null
---

# BL-0039: Opt-in 1-hour prompt cache for Claude Turns

## Description

The Claude CLI already caches prompts in `claude -p`, with a 5-minute lifetime by default. In Discord, the next owner message often arrives more than 5 minutes later. The CLI then writes the whole resumed conversation to the cache again. Add an opt-in runtime-home `.env` setting, for example `CLAUDE_PROMPT_CACHE_TTL=1h`. When it is set, `ClaudeRuntime` sets `ENABLE_PROMPT_CACHING_1H=1` only in the environment of the Turn processes it spawns. Follow the `CLAUDE_ALLOWED_TOOLS` pattern from IP-0006 T-0007. Do not change global Claude configuration.

## Context and evidence

- Robin events show caching works today: for example, event 518 `input=64449; cached=421590`, and event 505 `input=60031; cached=519467`. `input` includes cache-write tokens.
- CLI 2.1.314 help text: "5 minutes unless ENABLE_PROMPT_CACHING_1H=1". The CLI also has `FORCE_PROMPT_CACHING_5M` and `DISABLE_PROMPT_CACHING`.
- `loadConfiguration` reads the runtime-home `.env` into inoai settings, not into `process.env`. A `.env` line alone therefore does not reach the CLI.
- `ClaudeRuntime.attempt` spawns the CLI with the inherited `process.env`.

## Discussion

- A 1-hour cache write costs about 2× normal input, against 1.25× for a 5-minute write. A cache read costs about 0.1× either way. The setting pays off only when the owner often replies after 5 minutes but within the hour.
- Memory reviews use `--no-session-persistence` and gain nothing. Keep the review and probe environments unchanged.
- The owner can try it without code: start the bot with `ENABLE_PROMPT_CACHING_1H=1` in the shell, then compare the `input=` and `cached=` values in the usage Events.

## Open questions

- How does a Claude subscription count 1-hour cache writes against its usage limits? Measure with the shell trial before building.
