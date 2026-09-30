---
agent: reviewer
role: reviewer
tool: codex
task: task-0026
task_title: "Phase 4: Live Discord approval controls"
status: handoff
---

# Task 0026 reviewer handoff

Review not accepted yet. No implementation edits made; leave task in `review` for planner to return to the worker.

## Findings

1. **High — approval prompt is not actionable.** `src/approval-relay.ts:52-55` renders only “execute a command,” “change project files,” or “network access.” Those strings identify no command, affected file/root, network destination, or permission scope. The owner cannot tell what clicking Approve authorizes, especially when several approvals are live in one thread. The app-server provides structured command/cwd/commandActions, network host/protocol, and file-change grantRoot plus item changes. Preserve the no-secrets rule, but show a bounded, safe action-specific preview or fail closed when no safe preview is possible. Add tests for distinct requests and secret-bearing fields. Official OpenAI Docs: https://learn.chatgpt.com/docs/app-server (Approvals section).

2. **Medium — failed final UI edit strands enabled controls.** `src/approval-relay.ts:22-37` atomically finalizes the row and answers Codex, then awaits `disableApproval` without handling an edit failure. A transient Discord error leaves Approve/Reject visibly enabled while the row is final; the second click is inert and there is no retry record/path for that final-state edit. This misses the acceptance criterion that final state and disabled buttons are visible. Add a recoverable retry/reconciliation path for finalized rows (possibly coordinated with task 0027), and a focused failed-edit test. Do not re-answer Codex on retry.

## Checks and residual scope

- `npm test`: 58/58 pass. Existing test verifies owner/message gate and exact-once response on the happy path.
- The SQLite `UPDATE ... WHERE state = 'pending'` gate, owner/workspace/conversation/message checks, and in-memory live request check are sound for the tested path.
- No live Discord/app-server end-to-end check was run. Task 0027 owns expiry and restart recovery; Phase 5 owns application wiring.
