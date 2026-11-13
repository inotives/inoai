---
id: BL-0040
title: Upstream license notice for the SDK's vendored partial-json-parser
type: idea
status: open
created_at: 2026-11-12T16:43:26Z
source: IP-0007 T-0001 reviewer handoff
promoted_to: null
---

# BL-0040: Upstream license notice for the SDK's vendored partial-json-parser

## Description

`@anthropic-ai/sdk` vendors `partial-json-parser`. The standalone `THIRD_PARTY_NOTICES` reproduces only the SDK's README for that folder. The README says the code was vendored from the npm package `partial-json-parser`. The upstream package's own copyright and license text is not included.

## Context and evidence

- IP-0007 T-0001 reviewer handoff (follow-ups), 2026-11-12.
- `scripts/build-standalone.mjs`, the vendored parser section.

## Discussion

- None yet.

## Open questions

- Which license and copyright does the upstream `partial-json-parser` package carry?
