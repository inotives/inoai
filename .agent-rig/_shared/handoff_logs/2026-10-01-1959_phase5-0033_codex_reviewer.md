---
agent: reviewer
role: reviewer
tool: codex
task: task-0033
task_title: "Phase 5: Prompt context and shared Memory"
status: blocked
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0033 independent review

## Findings

1. **Secret-like Memory can reach Codex** (`src/prompt-context.ts:9,33`). The filter misses a common underscore-delimited credential name such as `AWS_SECRET_ACCESS_KEY=...`. In an isolated in-memory database, a relevant active Memory containing that name was included when the current user asked about production configuration. Manual Memory insertion does not reject it either. Expand the conservative secret exclusion and add a regression test; do not print real credentials.
2. **Quoted reply plus Memory can exceed the 6,000-character context budget** (`src/prompt-context.ts:28,40-49`). The two-section separator is not fully accounted for. In an isolated in-memory database, a reply with one maximally fitting relevant Memory produced a 6,001-character context prefix before `Current user message:`. Budget the rendered context, including separators, and test the exact boundary.

## Verified

- Reply lookup is scoped by Session, transport, workspace, and external message ID; missing targets leave input unchanged. Active Memory retrieval excludes soft-deleted rows, and the worker composes at processing time.
- `npm test`: 76 passed, 0 failed. `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- No implementation files, task statuses, commits, or remote state changed in this review.

Hold task 0034 until both findings are fixed and independently re-reviewed.
