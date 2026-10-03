---
id: task-0059
title: "Phase 6: Runtime review seam"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0058
message: "Runtime review seam: Claude text-only, Codex implemented, OpenCode
  unsupported; abort fix; re-review clean, 159 tests"
---






# Task

## Context

`AgentRuntime` currently serves chat Turns only. Reviews need one narrow text-only, throwaway call per adapter (ADR 0010, ADR 0001).

Sources: Phase 6 in `docs/implementation-phases.md`, the proposal's "Persisted inoai memory" and "Memory review loop" sections, `docs/sqlite-schema.md` (memory_reviews, memories, review notes), ADRs 0002, 0010, `docs/plan-review.md` decision 30, `CONTEXT.md` (Recap, Memory Review, Memory Signal, Manual Memory Entry). Live verification is Claude only; Codex is fake-tested; OpenCode skips reviews.

## Goal

Add the runtime review seam with Claude and Codex implementations and an explicit OpenCode unsupported result.

## Scope

- Add one narrow method (e.g. `review(prompt, projectPath): Promise<string>` plus a way to report unsupported) to `AgentRuntime`; no plugin registry.
- Claude: spawn per the spike's restricting flags plus `--safe-mode` and `--system-prompt <fixed inoai review instructions>` replacing the default system prompt (owner decisions after the spike review; do not use `--append-system-prompt` for reviews); fail the review closed (replay-safe) if the init event reports any `memory_paths`, MCP servers, or tools, or the stream contains any `tool_use` block, `permission_denied` event, or non-empty `permission_denials`; fake-CLI tests assert argv includes `--safe-mode` and `--system-prompt` and never `--append-system-prompt`, `--resume`, or `--session-id`; reuse the probe's project-folder cleanup, which tolerates a missing folder, no shell, prompt on stdin, `--model=` only when `CLAUDE_MODEL` is set, bounded timeout, kill guard, credential/apiKeySource checks as for Turns, classify from the `result` event; never use or resume a thread's Agent Session.
- Codex: ephemeral `thread/start` with `sandbox: "read-only"`, `approvalPolicy: "never"`, `ephemeral: true` (the Phase 5 probe settings), one turn, collect the final agent message; decline any approval request as today.
- OpenCode: report reviews unsupported without spawning anything.
- Failures map to existing `RuntimeFailure` kinds; reviews are always replay-safe at the engine level because they write nothing.
- Deterministic fake-CLI / fake app-server tests for Claude and Codex (argv/params safety, no session reuse, timeout, cancel/abort), and OpenCode unsupported; Codex is not live-verified in this phase.

## Planner Notes

Restricting options apply only to sessions inoai creates for reviews and never change the owner's configuration or chat Turn behavior.

## Implementation Plan

1. Add the seam and Claude/Codex/OpenCode implementations → verify: fake tests.
2. Full checks → verify: npm test, typecheck, build, diff checks.

## Acceptance Criteria

- [ ] Claude and Codex reviews run text-only in throwaway sessions with no permission elevation.
- [ ] OpenCode reports unsupported without spawning.
- [ ] Chat Turn behavior and existing tests are unchanged.

## Notes

- 2026-10-03 worker (claude): Added optional `AgentRuntime.review?(prompt, { signal })` plus exported `reviewInstructions` and `ReviewOptions` in `src/agent-runtime.ts`. Absence means unsupported (OpenCode declares `readonly review = undefined`), so the engine can skip before selecting or redacting anything and no new failure kind or Turn notice is needed. No `projectPath` parameter: both adapters run in a fresh `mktemp` cwd so project CLAUDE.md/AGENTS.md never shape a text-only summary. Claude: spike flags + `--safe-mode` + `--system-prompt <reviewInstructions>`, `--model=` only when configured, stdin prompt, total `reviewTimeoutMs` (default 600 s), abort → SIGINT, pid-guarded kill, fail closed (SIGKILL, replay-safe) on init `memory_paths`/non-empty or missing `tools`/`mcp_servers`/`apiKeySource` ≠ none, any `*tool_use` block, `permission_denied`, or non-empty `permission_denials`; success requires an init; cleanup removes the cwd and reuses the now-exported `removeProbeProjectFolder` (tolerates absence, warns with a fixed path-free message). Codex: ephemeral read-only `thread/start` (approval never, developerInstructions = reviewInstructions), one `turn/start` (readOnly, never), final agent message, fail closed on any item type other than userMessage/agentMessage/reasoning, timeout/abort → bounded `turn/interrupt` (never closes the shared app-server), review threads never enter the session map. All review failures are replay-safe existing `RuntimeFailure` kinds. Tests 144 → 156 (`src/test/runtime-review.test.ts` +11, `approval-relay.test.ts` +1). typecheck, build, diff checks clean. Optional real haiku review: PASS (text returned, no leftover folders).
- 2026-10-03 worker (claude, review fix): M1 — an abort while the review cwd was being created was lost. Claude now re-checks `signal.aborted` (and `closed`) after `mkdtemp`/`realpath`, removing the cwd and throwing `cancelled` (or `pre_start` after close) before spawning, and calls `onAbort()` immediately after attaching the listener if already aborted. Codex calls `onAbort()` right after attaching the listener when already aborted and throws the failure before `thread/start` (cwd removed in `finally`). L1 — fail-closed table adds missing `mcp_servers` and missing `apiKeySource`; new test that `close()` stops a running review (child dead, cwd gone, rejects replay-safe) and that a close racing cwd creation never spawns. Regression tests for same-tick abort (Claude: no spawn; Codex: no `thread/start`/`turn/start`), using an isolated `TMPDIR` to prove the cwd is removed; they fail (30 s timeout) with the fix reverted. Tests 156 → 159. typecheck, build, diff checks clean; review file 5x serial + 4x parallel green.
