---
id: task-0066
title: "Phase 6b: Codex CLI safety probe"
type: research
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: "Reviewed worker handoff and Phase 6b spike: real Codex probe used
  ephemeral read-only/never settings and synthetic injection input; MCP startup
  notifications were observed, so safety gate correctly fails closed. No source
  changes, no secret leakage, cleanup and diff checks verified."
---





# Task

## Goal

Verify whether the installed Codex CLI can run a Memory Review in a disposable throwaway session with no tools or MCP servers exposed.

## Scope

- Use only synthetic, secret-free archived Messages, including instruction-like and tool-triggering text.
- Use a disposable project/runtime home; never alter the owner's archive, configuration, credentials, or Discord runtime.
- Exercise the existing read-only sandbox and approval policy `never` settings.
- Capture effective startup/session metadata, tool/MCP exposure, output shape, exit status, and cleanup.
- If the session is unavailable, unauthenticated, unsafe, or cannot prove tool/MCP absence, record that as a safety failure rather than weakening restrictions.

## Acceptance Criteria

- [ ] Probe evidence states whether tools and MCP servers are absent.
- [ ] Injection-like input causes no tool execution or filesystem change.
- [ ] No secrets or real archived Messages enter prompts, logs, or committed files.
- [ ] Disposable files/processes are cleaned up.
- [ ] Findings are recorded in a handoff and a phase-6b spike document.

## Notes

This task is research only; do not change `src/`.
