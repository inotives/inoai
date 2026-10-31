---
id: BL-0035
title: Claude allowed tool rules and .env.sample entry
type: idea
status: open
created_at: 2026-10-31T00:33:00Z
source: IP-0006 T-0007 worker handoff 1 and reviewer handoff 1
promoted_to: null
---

# BL-0035: Claude allowed tool rules and .env.sample entry

## Description

`CLAUDE_ALLOWED_TOOLS` accepts only plain tool names. It rejects Claude tool rules such as `Bash(git status:*)`, because their spaces and wildcards can split or widen permissions. If the owner needs narrow rules, design a safe form for them. Also add a commented `CLAUDE_ALLOWED_TOOLS=` line to `.env.sample`.

## Context and evidence

- [T-0007 reviewer handoff 1](../features/IP-0006--memory-feedback-loop/tasks/T-0007--claude-allowed-tools/handoffs/20261031_003208--reviewer-handoff-1.md), Follow-ups.
- `src/inoai/agent-instance/config.ts`, `INSTRUCTIONS.md` Claude section.

## Discussion

None

## Open questions

- None
