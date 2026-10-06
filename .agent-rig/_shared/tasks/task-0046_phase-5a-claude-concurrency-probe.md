---
id: task-0046
title: "Phase 5a: Claude concurrency probe"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on:
  - task-0042
message: Tool-free Claude concurrency probe with bounded wait and safe kill
  guard; re-review clean, 122 tests
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---






# Task

## Context

The Codex probe gates per-session concurrency at startup and falls back to global FIFO. A Claude probe cannot run Bash without inoai granting permission, which ADR 0007 forbids.

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Validate Claude cross-session concurrency without granting any permission.

## Scope

- Start two ephemeral Claude sessions in a disposable temporary project with tools disabled, each asked to produce a long counted list.
- Pass only when both sessions stream text before either completes and both complete successfully; anything else returns false.
- Use `--no-session-persistence`. The CLI still creates `~/.claude/projects/<encoded temp cwd>/memory/`; after verifying it contains only the probe's empty artifacts, delete that exact folder by literal path along with the temp project.
- Confirm which CLI flag disables all tools for the probe sessions (restricting only) and record it.
- Bound the probe with a timeout and wire it through the provider switch; log the same enabled/fallback line style as Codex.
- Unit-test the pass rule with recorded timelines; never call the real CLI in unit tests.

## Planner Notes

Disabling tools in the probe's disposable sessions restricts rather than elevates permissions.

## Implementation Plan

1. Implement the pass rule and probe → verify: timeline unit tests.
2. Wire into startup → verify: full checks; optional manual authenticated run.

## Acceptance Criteria

- [ ] Overlapping streams enable per-session mode; sequential, failed, or timed-out runs keep global FIFO.
- [ ] The probe grants no permission and leaves no files outside its temporary project.
- [ ] Queued Messages are never dropped by a probe failure.

## Notes

- 2026-10-02 worker: Implemented `probeClaudeConcurrency()` and the pure pass rule `probeShowsConcurrentStreaming()` in `src/concurrency-probe.ts` (beside the Codex probe: one module owns the startup concurrency gates, and the Claude probe spawns its own throwaway processes rather than going through `ClaudeRuntime`, whose argv carries session flags and the owner's model). Tools-disable flag confirmed against CLI 2.1.287 `--help` and one real init event: `--tools ""` removes every built-in tool (init `tools: []`); `--strict-mcp-config` with no `--mcp-config` also removes MCP servers (init `mcp_servers: []`). Both only restrict. Probe argv: `-p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config --model=haiku`, prompt on stdin (counted list 1-150). Wired into the `claude` provider branch; a supplied runtime still skips the probe. Cleanup deletes `~/.claude/projects/<encoded realpath>` only when it holds nothing but an empty `memory/` (non-recursive `rmdir`), otherwise logs a fixed path-free warning. Real authenticated run: `true` in ~7s, no project folder or temp project left. Checks: npm test 120/120, typecheck, build, `git diff --check` clean.
- 2026-10-02 worker (review fixes): (1) Bounded the final wait. Each child's wait still resolves on `close`, but `exit` now starts a 2 s grace timer. If `close` has not fired by then, the timer destroys the child's stdio and resolves. The probe therefore returns within timeout + 2 s even when a leftover process holds stdout open. The new fake-CLI test spawns a detached grandchild holding stdout. The probe returns false in under 6 s with the CLIs dead and cleanup done, and the test kills the grandchildren. Without the bound the test hangs, which I confirmed by temporarily disabling it. (2) Exported `killProbe` and added a non-destructive unit test with fake children: no pid → no kill, exited → no kill, running → SIGKILL. The spawn-failure test now runs the probe in a detached child process, its own process group, so a regressed guard cannot signal the test runner. (3) `withFakeClaude` in transport.test.ts sets `HOME` to a temp dir and restores it, so `run()`'s real probe never touches the real `~/.claude`. The probe argv and the pass rule are unchanged. npm test 122/122, typecheck, build, and `git diff --check` are clean.
