---
id: BL-0043
title: API runtime idle timeout during long silent thinking
type: bug
status: open
created_at: 2026-11-12T17:03:01Z
source: IP-0007 T-0003 reviewer handoff
promoted_to: null
---

# BL-0043: API runtime idle timeout during long silent thinking

## Description

The `anthropic-api` runtime ends a Turn as `timed_out` after 300 s with no stream event. The SDK drops SSE `ping` events, and adaptive thinking defaults to `display: "omitted"` on current models. A long thinking or server-tool phase, especially at high or max effort, may therefore send no visible event for 300 s and be cut off even though the request is healthy.

## Reproduction

- Steps to reproduce: run an `anthropic-api` home at `ANTHROPIC_API_EFFORT=max` and ask a hard question that needs a long thinking phase.
- Expected: the Turn completes.
- Actual (suspected, not yet observed): the Turn ends as `timed_out` after 300 s with no stream event.

## Context and evidence

- IP-0007 T-0003 reviewer handoff (follow-ups), 2026-11-12.
- `core/streaming.js` in `@anthropic-ai/sdk` skips `ping` events.

## Discussion

- [2026-11-12] The project-manager will watch for this during the IP-0007 live check.

## Open questions

- Should thinking use `display: "summarized"` to keep events flowing, or should the idle timer count ping or raw SSE activity?
