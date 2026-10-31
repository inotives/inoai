---
id: BL-0030
title: memory add with a lone --core creates a Memory named "--core"
type: bug
status: open
created_at: 2026-10-30T23:10:33Z
source: IP-0006 T-0001 reviewer handoff 1
promoted_to: null
---

# BL-0030: memory add with a lone --core creates a Memory named "--core"

## Description

`inoai memory add --core` with no text matches the single-value branch in `parseMemoryCommand` (`src/inoai/app.ts`). It creates a `topic` Memory whose body is the literal `--core`. A lone `--core` should be a usage error.

## Reproduction

- Steps to reproduce: run `inoai memory add --core` against a runtime home.
- Expected: usage error `inoai memory add [--core] <text>`.
- Actual: a `topic` Memory with body `--core` is created.

## Context and evidence

- [T-0001 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0001--memory-schema-and-store/handoffs/20261030_230959--reviewer-handoff-1.md), Follow-ups.
- The same input created this Memory before IP-0006. The Memory is soft-deletable.

## Discussion

None

## Open questions

- None
