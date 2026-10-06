---
agent: reviewer
role: reviewer
tool: claude
task: task-0054
task_title: "Phase 5b: README OpenCode setup"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0054 reviewer handoff

Independent review of the README change. No implementation edits were made, task status is unchanged, nothing was committed, and no `.inoai-connect*/.env` was read.

## Verdict

Accurate and close to clean. One Low consistency finding and one Nit. Everything else checks out against the code and docs.

## Findings

1. **Low: README.md lines 9 and 13 ("V1 in brief") still describe only Codex and Claude.** Line 9 says "Codex CLI runtime, with Claude CLI as a second runtime from Phase 5a". Line 13 says "Claude follows the same rules with its own local settings". OpenCode is missing from both. This is not "deferred" wording, but it conflicts with the new section and with AGENTS.md lines 62 and 140. Fix: add OpenCode to both bullets. For example, line 9 could end "...Claude CLI (Phase 5a) and OpenCode (Phase 5b) as further runtimes", and line 13 could say "Claude and OpenCode follow the same rules with their own local settings." Alternatively, explicitly defer this to the final-review status-line update, alongside line 5.
2. **Nit: README.md line 223 says "OpenCode ignores the `instructions` config setting" with no version.** The spike and the comment in src/opencode-runtime.ts limit this to 2.0.22. Optional fix: say "OpenCode (2.0.22) ignores…", or "the `instructions` setting is not applied".

## Verified (no issue)

- The commands, `--connect-dir`, the `validate`/`start` scripts (package.json), `AGENT_PROVIDER=opencode` (src/config.ts:38), and `.env.sample` keys match the code. `CLAUDE_MODEL` is ignored for non-claude homes (src/config.ts:41).
- Startup check: `opencode --version` with the error `OpenCode CLI is unavailable` (src/opencode-runtime.ts connect, src/index.ts:356-359). Validation is offline.
- `opencode run --format json --standalone`, resume via `--session`, and cwd = `session.projectPath` = `dirname(runtimeHome)` (src/index.ts:91,148). So "sessions appear in OpenCode's session list for the deployment folder" is correct: the spike says `session list` is per project, scoped to the current project.
- Persona: a delimited block prepended to the stdin prompt (`personaPrompt`). agent.md is re-read on create and resume (src/agent-session.ts:11,20), so "edits apply from the next Turn" holds.
- Permission notice: `permissionDenialNotifier`, "Use local OpenCode for the blocked action" (src/approval-relay.ts). Authentication notice covers a free-tier refusal (src/opencode-runtime.ts authenticationNotice; src/runtime-turn.ts:14).
- Global FIFO with no probe (src/index.ts:357-358). Provider mismatch notice (src/conversation-worker.ts:18-22). session_missing notice (src/runtime-turn.ts:20).
- Data and billing, the free-tier risk, and the no `--auto`/`--yolo`/`--dangerously-skip-permissions` line match ADR 0009 and spike line 166 without overclaiming.
- No stale "OpenCode deferred" wording in README (the Deferred list now reads "Slack and Telegram"), AGENTS.md, or the proposal.
- The ADR 0009 link resolves, and `#running-alongside-other-homes` matches its heading.
- No secrets or real IDs. `git diff --check` is clean.

## Next

The worker applies finding 1 (and optionally 2), then a quick re-review.

## Suggested skills

None required.
