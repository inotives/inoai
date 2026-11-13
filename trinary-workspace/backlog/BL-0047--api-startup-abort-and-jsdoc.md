---
id: BL-0047
title: Abort the API startup model check on shutdown; fix misplaced JSDoc
type: idea
status: open
created_at: 2026-11-12T17:30:43Z
source: IP-0007 T-0006 reviewer handoff
promoted_to: null
---

# BL-0047: Abort the API startup model check on shutdown; fix misplaced JSDoc

## Description

- **Startup abort.** `checkAnthropicApiModel` takes no abort signal. A SIGINT or SIGTERM during the `anthropic-api` startup model check therefore waits up to its 30 s timeout before exiting. The instance lock is already released at once. Pass `startupAbort.signal` through to the SDK request options.
- **JSDoc.** In `src/inoai/connectors/agent-runtime/anthropic-api-runtime.ts` (around lines 41-42), `anthropicApiAuthenticationNotice` sits between the refusal-notice JSDoc and `anthropicApiRefusalNotice`, so the comment attaches to the wrong constant.

## Context and evidence

- IP-0007 T-0006 reviewer handoff (findings and follow-ups), 2026-11-13.

## Discussion

- None yet.

## Open questions

- None
