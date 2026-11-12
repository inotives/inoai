---
id: BL-0041
title: Triage npm audit findings
type: bug
status: open
created_at: 2026-11-12T16:43:26Z
source: IP-0007 T-0001 worker handoff
promoted_to: null
---

# BL-0041: Triage npm audit findings

## Description

`npm install @anthropic-ai/sdk` during IP-0007 T-0001 reported audit findings. Nobody has looked at them yet. They may come from existing or new dependencies.

## Reproduction

- Steps to reproduce: run `npm audit` on the branch with `@anthropic-ai/sdk` installed.
- Expected: no findings, or findings that have been triaged.
- Actual: `npm install` reported findings; the details were not recorded.

## Context and evidence

- IP-0007 T-0001 worker handoff (remaining concerns), 2026-11-12.

## Discussion

- None yet.

## Open questions

- Which packages are affected, and do they ship in the standalone bundle?
