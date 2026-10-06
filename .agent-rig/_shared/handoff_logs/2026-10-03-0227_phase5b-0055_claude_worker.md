---
agent: worker
role: worker
tool: claude
task: task-0055
task_title: "Phase 5b: Live OpenCode Discord smoke acceptance"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0055 live OpenCode smoke handoff

Run by the planner session in the worker role because each step needed the owner's live Discord actions. The bot token was never read or printed; the owner's `.inoai-connect-claude/.env` was copied by path into a disposable deployment and only `AGENT_PROVIDER` was rewritten to `opencode` with `sed`.

## Setup

- OpenCode v2.0.22 (`~/.opencode/bin` prepended to PATH for the bot process), free Zen default model; `npm run build` from `feature/phase-5b` (144 offline tests at task-0057 close).
- Disposable deployment `/tmp/inoai-phase5b-smoke.97H2Wj/` with `.inoai-connect-opencode/.env` (mode 600). OpenCode's project path was this empty folder.
- No other inoai process was running; Codex and Claude bots (same token) stayed stopped.
- `validate --connect-dir .inoai-connect-opencode`: valid. Startup log: `OpenCode cross-session concurrency: unavailable; using global FIFO`, `inoai started …`. SQLite: one `startup_online` Event.

## Live checks

| Step | Owner action | Evidence | Result |
|---|---|---|---|
| a | Top-level mention in a non-status channel: "what's 2+2? Answer in one sentence." | Session 1 `opencode` active; `agent_session_id` rebound from the placeholder to a 30-char `ses_…` ID, `updated_by=runtime:opencode`; agent reply "2 + 2 equals 4." completed, delivery `confirmed`; `runtime_attempt`/`runtime_completed` attempt=1 | Pass |
| b | No-mention follow-up "What did I just ask you?" | Still one session; reply quoted the first question; delivery confirmed | Pass (`--session` resume across standalone processes) |
| c | "Read the file /etc/hosts and tell me how many lines it has." | One `approval_unsupported` Event `declined: no safe action preview; denials=1` by `runtime:opencode`; fixed OpenCode notice archived and confirmed; `approvals` 0 rows. **OpenCode still answered "9 lines"** — it reached the file through another allowed tool (OpenCode's default rules allow `*`, asking only for external-directory file tools and `.env` reads). inoai neither loosened nor tightened OpenCode's policy | Pass for inoai behavior; policy observation for the owner |
| d | Long counting prompt, then `/inoai cancel` | User Message `failed` "Cancelled by owner"; `runtime_failure reason=cancelled; replay_safe=false`; no partial answer; no `opencode run` process left | Pass |
| e | `/inoai status`, `/inoai reset`, no-mention follow-up | Status: project path, active, queued 0 / running 0 / failed 1. Session 1 `ended`, not soft-deleted, 8 Messages kept. Session 2 `opencode` active in the same conversation with a different `ses_…` ID; reply had no memory of earlier messages and recognised the `agent.md` block as "not a user message" | Pass |
| f | Mention in the status-only channel | Still 2 sessions, 10 Messages, 12 Events | Pass |

Discord text reported by the owner matches the archived rows for every step.

## Shutdown

SIGINT; the bot exited 0 and checkpointed the WAL. No `opencode run` children remained. The disposable SQLite is retained for review; the two smoke OpenCode session IDs are saved in the planner scratchpad for cleanup after review.

## Observations

- **OpenCode default permissions are permissive.** Built-in rules allow shell and most tools; only a few cases `ask` (and are auto-rejected). Through an owner-only bot this lets Discord messages drive shell commands in the project folder under OpenCode's default policy. This is preserved CLI policy, not inoai elevation, but it is materially more permissive than Codex/Claude defaults — owner decision needed.
- The persona block is visible to the model as context; it may mention it when asked about earlier content.
- Not exercised live (offline tests only): authentication/usage notices, provider mismatch, `session_missing`, idle timeout.

## Status

task-0055 set to `review`. No code changes. Nothing committed.
