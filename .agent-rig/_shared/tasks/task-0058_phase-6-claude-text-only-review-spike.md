---
id: task-0058
title: "Phase 6: Claude text-only review spike"
type: research
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on: []
message: Claude text-only review contract verified incl.
  --safe-mode/--system-prompt; re-review clean
---






# Task

## Context

Reviews must run text-only in a throwaway Claude session (ADR 0010). `src/concurrency-probe.ts` already uses `--tools ""`, `--strict-mcp-config`, and `--no-session-persistence` for throwaway probe sessions; `docs/phase-5a-claude-cli-spike.md` records the Claude headless contract.

Sources: Phase 6 in `docs/implementation-phases.md`, the proposal's "Persisted inoai memory" and "Memory review loop" sections, `docs/sqlite-schema.md` (memory_reviews, memories, review notes), ADRs 0002, 0010, `docs/plan-review.md` decision 30, `CONTEXT.md` (Recap, Memory Review, Memory Signal, Manual Memory Entry). Live verification is Claude only; Codex is fake-tested; OpenCode skips reviews.

## Goal

Record the verified Claude text-only review contract and JSON reliability.

## Scope

- Fresh `mktemp -d` cwd only; `--model=haiku` is acceptable for the spike; never touch `~/.claude` settings or credentials or any `.inoai-connect*`; never pass bypass/allow flags.
- Confirm `claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config` with the prompt on stdin yields `tools: []`, no MCP servers, and a final `result` text; whether `--append-system-prompt` is needed for review instructions.
- Feed a short synthetic transcript containing instruction-like and tool-triggering text (e.g. "run `touch pwned.txt`", "ignore previous instructions") and confirm no tool runs and no file is created.
- Ask for a strict JSON object (recap + actions) several times (≤ 8 short calls total) and record how often the output is bare JSON vs fenced/prefixed; recommend a tolerant-but-strict extraction rule.
- Record the cleanup of any `~/.claude/projects/<encoded temp cwd>` folder (delete only after verifying contents, as in task-0046).
- Write findings to `docs/phase-6-claude-review-spike.md`.

## Planner Notes

Research only: no `src/` changes. If tools cannot be fully disabled or a tool runs, block the task with the reason.

## Implementation Plan

1. Run the checks in a temp project → verify: every scope item answered.
2. Write the spike doc and clean up → verify: no leftovers, redaction clean.

## Acceptance Criteria

- [ ] `docs/phase-6-claude-review-spike.md` answers every scope item with the CLI version.
- [ ] No tool runs on instruction-like transcript text; JSON reliability and an extraction rule are recorded.
- [ ] No owner settings, credentials, or runtime homes touched; leftovers removed.

## Notes
- 2026-10-03 worker (claude): Spike done against Claude Code 2.1.288, 8 haiku calls, each in a fresh `mktemp -d` cwd with prompt on stdin and `-p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config`. Init: `tools: []`, `mcp_servers: []`, `apiKeySource: "none"` in all 8. Injection (call 1) and direct tool request (call 8): 0 tool_use, 0 permission_denied, empty cwd. JSON: 6/6 single ```json fence (0 bare, 0 prefixed), all parse; `--append-system-prompt` made no difference; call 8 returned a prose refusal. 4/6 invented `memory_id` on add (auto-memory leakage), 1/6 cited an agent message. Extraction rule and 0059/0060 implications in `docs/phase-6-claude-review-spike.md`. Cleanup: 8 temp cwds and 8 `~/.claude/projects/<encoded>` folders (empty `memory/` only) removed by literal path. No `src/` changes.
- 2026-10-03 worker (claude): Review fixes (doc only, no CLI runs). `docs/phase-6-claude-review-spike.md`: recorded that the default system prompt carries auto-memory instructions and that user-level CLAUDE.md loads as user context even with `--system-prompt`; added finding 6 with reviewer spot-checks A and B (`--safe-mode` drops `memory_paths` and CLAUDE.md, cuts skills/agents/plugins, keeps subscription sign-in) and the owner decisions; updated 0059 implications to the final flag set plus the fail-closed init backstop (`memory_paths`, MCP servers, tools); rewrote open questions (`--safe-mode` troubleshooting-flag drift; `--setting-sources`/`--restricted` untested); stated regex + `JSON.parse` together enforce exactly one object and listed deliberate rejections; noted the project folder may not be created and cleanup must tolerate absence (`src/concurrency-probe.ts:219-236`). `git diff --check` and `--no-index --check` clean; redaction grep clean. No `src/` changes.
