---
agent: worker
role: worker
tool: claude
task: task-0048
task_title: "Phase 5a: Live Claude Discord smoke acceptance"
status: handoff
---

# Task 0048 live Claude smoke handoff

Run by the planner session in the worker role because each step required the owner's live Discord actions relayed through the conversation. The owner's bot token was never read, printed, or placed in chat; the owner's runtime-home `.env` was copied by path into a disposable deployment folder.

## Setup

- Claude Code 2.1.287; `npm run build` from `feature/phase-5a` (122 offline tests passing at task-0047 close).
- Disposable deployment folder `/tmp/inoai-phase5a-smoke.1bnxe2/` with `.inoai-connect-claude/.env` copied from the repo's ignored `.inoai-connect-claude/.env` (mode 600). Claude's project path was this empty folder.
- Verified no other inoai process was running (the token is shared with the owner's Codex bot; the owner confirmed Codex stayed stopped).
- `validate --connect-dir .inoai-connect-claude`: valid.
- `node dist/index.js --connect-dir .inoai-connect-claude` started in the background. Log: `Claude cross-session concurrency: enabled`, `inoai started with …/.inoai-connect-claude`. The startup credential guard accepted the subscription login (startup proceeded past `connect()`). SQLite: exactly one `startup_online` Event.

## Live checks (owner actions in Discord, verified in the disposable SQLite)

| Step | Owner action | Evidence | Result |
|---|---|---|---|
| a | Top-level bot mention in a non-status channel: "what's 2+2? Answer in one sentence." | Session 1 `claude`, `active`, 36-char UUID, `updated_by=runtime:claude`; user Message completed; agent Message "2 + 2 equals 4." completed, delivery `confirmed`; Events `runtime_attempt`/`runtime_completed` attempt=1 | Pass |
| b | No-mention follow-up "What did I just ask you?" | Still only session 1; reply recalled the 2+2 question (owner-pasted reply); delivery confirmed | Pass (`--resume` continuity) |
| c | "Create a file named probe.txt containing the word hello." | No `probe.txt` in the project folder; one `approval_unsupported` Event `declined: no safe action preview; denials=1` by `runtime:claude`; fixed notice archived and confirmed; `approvals` table 0 rows; Turn completed with Claude's explanation | Pass (fail closed) |
| d | Long counting prompt, then native `/inoai cancel` | Private "Cancellation requested…" reply; user Message `failed` "Cancelled by owner"; Event `runtime_failure reason=cancelled; replay_safe=false`; no partial answer; no `claude -p` process left | Pass |
| e | `/inoai status`, `/inoai reset`, then no-mention follow-up | Status showed project path, active session, queued 0 / running 0 / failed 1. Reset: session 1 `ended`, not soft-deleted, 8 archived Messages retained. Follow-up created session 2 `claude` in the same conversation with a different agent session ID; reply had no memory of earlier messages | Pass |
| f | Top-level bot mention in the status-only channel | No new session, Message, or Event (still 2 sessions, 10 Messages) | Pass |

Discord Messages observed by the owner match the archived SQLite rows for every step.

## Shutdown

SIGINT to the bot process; it exited 0. No `claude -p` children remained. The disposable SQLite is retained at `/tmp/inoai-phase5a-smoke.1bnxe2/.inoai-connect-claude/inoai.sqlite` for review.

## Observations

- UX: in step c, Claude's own reply suggested `--permission-mode acceptEdits` or an allow rule. inoai never acts on this, but the owner may want `agent.md` guidance telling Claude not to suggest loosening permissions from Discord.
- Claude persisted the smoke sessions under one `~/.claude/projects/<encoded /private/tmp/inoai-phase5a-smoke…>` folder. Remove it and the disposable folder after review.
- Not exercised live (covered by offline tests): expired login and usage-limit notices, provider-mismatch notice, missing-session notice.

## Status

task-0048 set to `review`. No code changes. Nothing committed.
