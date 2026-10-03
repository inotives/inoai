---
agent: codex
role: reviewer
tool: codex
task: task-0077
task_title: "Phase 6c: Integrated review and acceptance"
status: blocked
---

# Phase 6c integrated review

## Finding

1. **High — configured BigQuery sync is not wired into production startup.**
   `src/bigquery.ts` provides a dependency-free `BigQueryClient` interface and
   `BigQuerySyncScheduler`, but `src/index.ts:start()` only opens the database
   and returns the instance (`src/index.ts:54-75`). It never constructs a
   Google BigQuery client, passes one to the scheduler, starts the scheduler,
   or stops it during `release()`. There is also no Google BigQuery SDK or
   ADC-backed client in `package.json`. Consequently, setting valid
   `BIGQUERY_PROJECT_ID`, `BIGQUERY_DATASET_ID`, and
   `BIGQUERY_SYNC_INTERVAL_MINUTES` does not upload anything; the implemented
   behavior is limited to the fake-sink/offline boundary. This fails the Phase
   6c testable outcome for configured instances and leaves the documented
   production boundary incomplete. Add the smallest ADC-backed production
   client and lifecycle wiring, or explicitly split it into an approved
   follow-up phase before declaring Phase 6c complete.

## Verified behavior

- Optional configuration is disabled by default and malformed optional values
  do not block core startup.
- Agent Instance metadata is singleton per runtime-home database, with stable
  UUID and configurable non-unique name.
- The fake exporter covers six tables, composite identity keys, redaction,
  tombstones, overlap watermarks, bounded retry/defer events, and two-home
  collision isolation.
- No credentials, ADC material, or raw tool payloads are selected by the
  exporter code reviewed.
- No live BigQuery setup or Discord test was performed, as requested.

## Verification

- `npm test` — 205 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

## Disposition

Task 0077 remains blocked. Do not mark Phase 6c complete or proceed to the
live ADC/setup step until the production wiring decision is resolved and the
configured path is either implemented and reviewed or explicitly deferred.
