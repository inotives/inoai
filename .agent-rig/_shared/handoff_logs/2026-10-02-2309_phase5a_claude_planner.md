---
agent: planner
role: planner
tool: claude
task: phase-5a
task_title: "Phase 5a: Claude runtime"
status: done
---

# Phase 5a planner handoff

Phase 5a adds Claude CLI as a second V1 Agent Runtime with Codex parity. Branch `feature/phase-5a`; nothing committed, staged, or pushed.

## Owner decisions

- Full Phase 4/5 parity; Phases 6–8 cover both providers. Guiding rule: match Codex unless a Claude difference forces otherwise.
- Per-agent config stays in the runtime-home `.env` (`AGENT_PROVIDER=claude`, optional `CLAUDE_MODEL`); no YAML.
- Fail-closed permission prompts (ADR 0007), passing `--permission-prompts none`.
- Drive the installed headless `claude -p` per Turn, not the Agent SDK (ADR 0008), because of the SDK's subscription-login policy note.
- Credential guard accepts only the interactive subscription `/login`; `CLAUDE_CODE_OAUTH_TOKEN` and every other source is refused (D3).
- `agent.md` via `--append-system-prompt` with `--system-prompt-snapshot off` every Turn; project guidance from Claude's own `CLAUDE.md`.
- Provider mismatch refuses per thread; `/inoai reset` switches provider. Missing Claude session after restart fails closed with a reset notice (`session_missing`), never silently recreated.
- Tool-free concurrency probe; keep `/inoai` for every bot with a clearer wrong-bot message.

## Tasks

task-0039 spike → 0040 config → 0041 provider seam → 0042 adapter → 0043 denials → 0044 credential guard → 0045 mismatch/wrong-bot → 0046 probe → 0047 README → 0048 live smoke → 0049 integrated review. All `done`, each with independent review; review-fix rounds on 0039 (×2), 0040, 0042, 0046, 0047.

Notable review catches fixed: `CLAUDE_MODEL` accepting leading-dash flags (0040), silent session recreation after restart (0042), probe startup hang and destructive kill-guard test (0046).

## Verification

- `npm test` 122/122, `npm run typecheck`, `npm run build`, `git diff --check` clean (task-0049).
- Live smoke (task-0048) against real Discord and Claude 2.1.287: start, resume, permission denial notice with no file written, cancel, status, reset to a fresh session in the same thread, status-channel ignore; probe enabled per-session concurrency; credential guard accepted the subscription login.
- Partial evidence only: successful resume after an inoai restart end to end; live skill/MCP tool use. Expired login, usage limit, provider mismatch, and missing session covered by offline tests only.

## Cleanup and follow-ups

- Smoke temp deployment, its copied `.env`, its `~/.claude/projects` folder, and a stale test fixture dir were removed. The owner's `.inoai-connect-claude/.env` (shares the Codex bot token) remains in the repo root and is git-ignored.
- Owner option: add `agent.md` guidance so Claude does not suggest loosening permissions from Discord.
- Never run the Codex and Claude homes concurrently while they share one bot token.
- Commit, push, or PR only on explicit owner request.
