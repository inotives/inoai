---
id: task-0039
title: "Phase 5a: Claude CLI headless contract spike"
type: research
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-02
updated_on: 2026-10-02
priority: high
parent: ""
depends_on: []
message: Spike verified on claude 2.1.287; three review rounds, final review clean
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---








# Task

## Context

ADR 0008 chose the installed headless `claude -p --output-format stream-json` CLI over the Agent SDK. Several design decisions rest on CLI behavior that has not been verified against the installed Claude Code (2.1.287 at planning time).

Sources: `docs/implementation-phases.md` Phase 5a, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, 0008, and `docs/plan-review.md` decision 28. Guiding rule: match Codex behavior unless a Claude difference forces otherwise.

## Goal

Record the verified headless CLI contract the adapter, approval, credential, and probe tasks will rely on.

## Scope

- Use only a disposable temporary project and read-only prompts; never touch the repository-root `.inoai-connect*` data or edit the owner's Claude settings, shell, or credentials.
- Capture the stream-json event shapes for init/system, text progress, tool use, and the final result (success, error, interrupted), including the session ID.
- Verify `--session-id <uuid>` on the first Turn and `--resume <uuid>` on later Turns, including across separate processes, and what happens when resuming an unknown ID.
- Verify `--append-system-prompt` adds to, rather than replaces, the default system prompt, and that `--model` accepts aliases and full IDs.
- Determine how a tool call that needs a permission prompt is denied in `-p` mode and whether the denial is observable (for example `permission_denials` in the result) without an MCP permission-prompt tool.
- Determine a supported way to learn which credential source the CLI will use (for example an init-event field or an auth status command) without reading credential files.
- Verify SIGINT ends a Turn cleanly and how authentication-expired and usage-limit failures appear.
- Determine whether a run can avoid persisting a session (for probe use) and where sessions for a temporary cwd are stored.
- Write findings to `docs/phase-5a-claude-cli-spike.md` with redacted, minimal samples.

## Planner Notes

This is research: no `src/` changes. If permission denials or the credential source cannot be observed reliably, set this task to `blocked` with the reason so the planner can return to the owner before choosing another mechanism (ADR 0008).

## Implementation Plan

1. Run the probes in a temporary project and record each result → verify: every scope bullet has a verified answer or an explicit unknown.
2. Write the spike document with redacted samples → verify: no secrets, account identifiers, or tokens appear.

## Acceptance Criteria

- [ ] `docs/phase-5a-claude-cli-spike.md` answers every scope item with the observed CLI version.
- [ ] Permission-denial reporting and credential-source detection are either confirmed or the task is blocked with a clear reason.
- [ ] No repository-root runtime home, Claude setting, or credential was read or modified.

## Notes

- 2026-10-02 worker: Spike done against Claude Code 2.1.287; findings in `docs/phase-5a-claude-cli-spike.md`. Permission denials are observable without an MCP prompt tool (`system/permission_denied` events and `result.permission_denials`; recommend `--permission-prompts none`). The credential source can be detected with `claude auth status --json` (`authMethod`/`apiProvider`/`apiKeySource`) plus the init event's `apiKeySource`. Unknown: exact expired-auth and usage-limit stream shapes. Probe sessions and the temp dir were deleted; no repo runtime home, Claude setting, or credential was touched.
- 2026-10-02 worker (review fixes): Applied reviewer findings 1-4 and owner decisions D1-D3 to `docs/phase-5a-claude-cli-spike.md`: guard accepts only `authMethod:"claude.ai"` and refuses `CLAUDE_CODE_OAUTH_TOKEN` (its report value marked unverified); snapshot caveat resolved with `--system-prompt-snapshot off`; `--permission-prompts none` recorded as decided; failure table adds `aborted_streaming` without cancel → `uncertain` and states classification is from the `result` event; probe deletes its own `~/.claude/projects/<encoded-cwd>/` folder by literal path and task-0046 confirms the tools-disable flag. No new CLI runs, no `src/` changes.
- 2026-10-02 worker (re-review fixes A/B): Spike doc now has the guard also refuse on `CLAUDE_CODE_OAUTH_TOKEN` env presence (presence only; task-0044) and labels the `--system-prompt-snapshot off` effect inferred, not observed (task-0042 verifies). Doc-only.
