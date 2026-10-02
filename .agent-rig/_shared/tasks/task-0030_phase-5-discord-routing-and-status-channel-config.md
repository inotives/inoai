---
id: task-0030
title: "Phase 5: Discord routing and status-channel config"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-01
updated_on: 2026-10-01
priority: high
parent: ""
depends_on: []
message: Independent review clean; 66 tests, typecheck, build, diff check passed
---




# Task

## Context

Phase 3 routes new Conversations only from `DISCORD_ALLOWED_CHANNEL_ID`. ADR 0006 changes that boundary: the configured server and active owner remain fixed, while any accessible non-report channel may start a Conversation with one top-level mention of this bot. The report channel becomes status-only.

## Goal

Make Discord routing and configuration match the accepted Phase 5 server-wide mention policy.

## Scope

- Rename the required setting to `DISCORD_STATUS_CHANNEL_ID` in configuration, value-free sample, and setup docs; do not retain an old-name alias or read/print token values.
- Post the one-per-process online Event only in that status channel; ignore conversation-start mentions there.
- Accept the active owner's single-bot top-level mention in another accessible channel of the configured guild, create its thread, and keep subsequent owner Messages in that bot-owned thread bound to it.
- Preserve rejections for other guilds/users/bots, ordinary top-level Messages, multi-bot mentions, and other bots' threads. A channel where thread creation fails must not create a Session or invoke Codex.
- Update focused config, inbound-policy, and transport tests for the new boundary. Do not implement queue-worker turns or slash controls here.

## Planner Notes

First ready worker task. The user's ignored runtime-home `.env` currently uses the old key; do not edit or display that file. Tell the planner when a local key rename is needed before the live test. Phase 3's original single-channel tests are historical; update them to the new accepted contract.

## Implementation Plan

1. Change configuration and routing with focused fake-Discord tests.
2. Verify online reporting, mention/thread isolation, typecheck, build, and diff check.

## Acceptance Criteria

- [ ] Only `DISCORD_STATUS_CHANNEL_ID` validates; the old key alone fails clearly without logging values.
- [ ] One online notice per process goes to the report channel; owner mentions there start no Conversation.
- [ ] An owner mention in another accessible channel of the configured guild creates one thread/Session; ordinary messages and all out-of-scope identities/channels do not.
- [ ] A message in a bot-owned bound thread remains eligible without a mention; duplicate gateway events create no duplicate Session/Message.

## Notes
