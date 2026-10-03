---
agent: codex
role: worker
tool: codex
task: task-0077
task_title: "Phase 6c: Integrated review and acceptance"
status: review
---

# Task 0077 null-parameter fix

## Change

- Added `buildBigQueryMergeQuery()` as the shared MERGE query builder.
- Every named BigQuery parameter now includes an explicit `types` entry using
  the table field type (`STRING`, `INT64`, or `TIMESTAMP`). This preserves the
  type of nullable values instead of allowing the Node client to infer a type
  from `null`.
- The production ADC-backed client and the test-facing query shape use the same
  builder, so the regression cannot drift between the two paths.
- Added coverage for nullable TIMESTAMP/INT64 parameters and the MERGE shape.

## Verification

- `npm test` — 207 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

## Live check

The direct configured export was attempted without starting Discord or an agent
runtime. It was blocked by the sandbox network resolver before reaching
BigQuery: `oauth2.googleapis.com` could not be resolved. No credential or raw
query data was printed. The local sync state records the normal non-secret
failure marker and retry backoff.

No commit or push was performed.
