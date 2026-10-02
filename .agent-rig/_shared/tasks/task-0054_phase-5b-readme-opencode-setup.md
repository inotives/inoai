---
id: task-0054
title: "Phase 5b: README OpenCode setup"
type: doc
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0053
  - task-0057
message: README OpenCode section; small fixes; re-review clean
---






# Task

## Context

The README has a Claude runtime section; OpenCode needs an equivalent.

Sources: `docs/implementation-phases.md` Phase 5b, the proposal's "OpenCode runtime (Phase 5b)" section, ADRs 0002, 0007, 0009, `docs/plan-review.md` decision 29, and the Phase 5a precedent (`docs/phase-5a-claude-cli-spike.md`, `src/claude-runtime.ts`, tasks 0039–0049). Guiding rule: match the Claude adapter's behavior unless an OpenCode difference forces otherwise.

## Goal

Document how to run an OpenCode Agent Instance and what it implies.

## Scope

- Prerequisites: OpenCode installed with `opencode` on the PATH of the shell that runs `npm start` (default install puts it in `~/.opencode/bin`).
- Setup with `--connect-dir .inoai-connect-opencode` and `AGENT_PROVIDER=opencode`; validate; start.
- Data and billing: inoai passes no model, so OpenCode's configured default answers; free Zen sends prompts and project context to opencode.ai; any provider later configured in OpenCode is used and billed as configured (ADR 0009).
- Behavior: standalone run per Turn, `AGENTS.md` native, `agent.md` as a delimited block prepended to every Turn's prompt, fail-closed permission notice, global FIFO, `session_missing`/mismatch notices.
- Free-tier note: the free tier allows use only "from within OpenCode"; inoai works today because it runs the stock CLI, but a future OpenCode change could refuse it, which surfaces as an authentication notice.
- Running alongside other homes: one bot per concurrently running instance.
- Add `.inoai-connect-opencode/` to the Agent Instances example and mark Phase 5b in the status line.

## Planner Notes

Commands must match the implementation exactly; no secrets or real IDs.

## Implementation Plan

1. Write the section → verify: commands and keys grep-match the code; links resolve.

## Acceptance Criteria

- [ ] A reader can set up and validate an OpenCode runtime home from the README alone.
- [ ] Data-flow, billing, and permission notes match ADR 0009 and the implementation.

## Notes

- 2026-10-03 worker: Added `## OpenCode runtime` to README.md after the Claude section (Prerequisites, Setup, Data and billing, Behavior, Running alongside other homes); added `.inoai-connect-opencode/` to the Agent Instances example; noted that OpenCode also reads `AGENTS.md` in Deployment layout. Status line left as "Phase 5b (OpenCode) is in progress" until the final review. Commands, flags, the `OpenCode CLI is unavailable` startup error, and notice behavior grep-matched against src/ and package.json; ADR link and anchor resolve; `git diff --check` clean. Docs only.
- 2026-10-03 worker (review fix): Added OpenCode to "V1 in brief" lines 9 and 13; qualified line 223 as "OpenCode (2.0.22)". `git diff --check` clean.
