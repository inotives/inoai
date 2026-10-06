---
agent: reviewer
role: reviewer
tool: codex
task: task-0026
task_title: "Phase 4: Live Discord approval controls"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0026 independent re-review

Not accepted. No implementation edits or task-state changes made.

## Finding

1. **High — other approval RPCs remain live and unanswered.** `src/approval-relay.ts:28-30` ignores every server request except the two `item/*` command/file methods. The locally installed Codex CLI `0.157.1` generated protocol also declares `item/permissions/requestApproval`, `applyPatchApproval`, and `execCommandApproval`. `src/codex-app-server.ts:121-124` retains each request ID until it is answered, but no other listener handles these approval methods. Such a request can leave the turn waiting indefinitely, without the explicit decline, safe owner notice, or non-secret outcome required for unsupported approvals. Handle these approval variants with their method-correct decline responses and safe notices, or establish and enforce a protocol mode in which they cannot occur. Add a focused regression for at least permissions approval; do not generically decline non-approval requests such as tool input/elicitation without a separate decision.

## Acceptance gap

`approvalSummary()` always returns `undefined` (`src/approval-relay.ts:11-14`), so even the two handled methods can only be declined. This is consistent with ADR 0003's safety boundary for CLI `0.157.1`, but task 0026's positive pending-row/control and owner-click acceptance criteria are unreachable. The planner must resolve that mismatch before marking the task done; do not fabricate a safe-preview success case.

## Verified

- The prior raw-command leak is fixed for both handled v2 methods. A token-shaped literal in command, path, host, or reason is not posted or persisted; a fixed safe notice and `approval_unsupported` Event replace actionable controls. The focused test checks no approval row or control.
- For reachable handled methods, unsupported requests are declined before the notice, and no wrapper-level permission elevation or command allowlist was added.
- Existing owner/exact-request/duplicate-click and failed-edit guards remain in code, but the click path has no reachable safe-preview case and was not behaviorally retested by the new regression.
- `npm test`: 58/58 pass; `npm run typecheck`, `npm run build`, and `git diff --check` pass. No live Discord bot or app-server end-to-end test was run.

