---
agent: planner
role: planner
tool: claude
task: phase-5b
task_title: "Phase 5b: OpenCode runtime"
status: done
---

# Phase 5b planner handoff

Phase 5b adds OpenCode as a third V1 Agent Runtime with Claude-adapter parity. Branch `feature/phase-5b`.

## Owner decisions

- Use whatever provider and model OpenCode is configured with (free OpenCode Zen today); no model setting, no credential guard (ADR 0009). Prompts and project context go to the configured provider.
- Parity with 5a minus the concurrency probe: OpenCode homes always use global FIFO.
- `opencode run --format json --standalone` per Turn, owned and killed by inoai.
- D1: `agent.md` is a delimited block prepended to every Turn's stdin prompt (OpenCode 2.0.22 ignores `instructions` config); project guidance from native `AGENTS.md`.
- D2 (task-0057): authentication and usage failures post the provider-worded fixed notice for Codex, Claude, and OpenCode (a pre-existing gap since Phase 5/5a).
- D3: keep OpenCode's permissive default permission policy (shell and most tools allowed); document it; the owner may tighten their own OpenCode config. A startup guard is a deferred follow-up.

## Tasks

0050 spike → 0051 config/wiring → 0052 adapter → 0053 denials → 0057 notices → 0054 README → 0055 live smoke → 0056 integrated review. All `done` with independent reviews; fix rounds on 0050 (×3), 0052, 0054.

Notable catches: the free tier rejects pre-assigned session IDs (first Turn runs without `--session` and the real `ses_` ID is rebound mid-Turn); `--session` silently creates unknown IDs (existence check + `session_missing`); replay-safety limited to spawn failure because OpenCode saves the message before its first event; session-ID validation before argv/API use.

## Verification

- `npm test` 144/144 (main 122), typecheck, build, diff checks clean.
- Live smoke (task-0055) with OpenCode 2.0.22 and free Zen: start, resume across standalone processes, permission notice, cancel, status, reset to a fresh session in the same thread, status-channel ignore. Step c showed OpenCode reaching the file via a default-allowed tool, leading to D3.
- Offline only: authentication/usage notices, provider mismatch, `session_missing`, idle timeout.

## Cleanup

Smoke deployment, copied `.env`, and both smoke OpenCode sessions removed; no stray processes. The owner's `opencode serve --service` was left untouched.
