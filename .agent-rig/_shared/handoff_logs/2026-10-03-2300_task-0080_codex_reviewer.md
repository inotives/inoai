---
agent: reviewer
role: reviewer
tool: codex
task: task-0080
task_title: Runtime recovery integrated review and acceptance
status: blocked
---

## Findings

1. **Medium — Phase 6c documentation is stale after production wiring.**
   `README.md` lines 44 and 160, `docs/adr/0012-optional-one-way-bigquery-analytics-sync.md` line 11, and the Phase 6c current implementation boundary in `docs/implementation-phases.md` still say that the Google BigQuery SDK is not bundled and that `src/index.ts` does not construct/start the scheduler. The current diff adds `@google-cloud/bigquery`, constructs the ADC-backed client, and starts/stops `BigQuerySyncScheduler` from `src/index.ts`. Update those statements to describe the implemented production path and retain only any genuine live-cloud test limitation.

## Runtime recovery review

- Codex timeout/process-loss turns remain uncertain and are never replayed.
- Pre-`turn/start` failure releases the in-memory guard; later queued work can reconnect and resume the persisted Session ID.
- Reconnect is serialized and bounded (0, 100, 250 ms); replacement servers rebind `ApprovalRelay`, and responses use the originating server.
- launchd is optional, uses absolute paths, contains no secrets, and preserves the runtime-home lock/manual-start boundary. Live `launchctl` KeepAlive testing is unavailable in this non-GUI environment and is documented honestly.

## Verification

- `npm test` — 210 passing
- `npm run typecheck` — passed
- `npm run build` — passed
- `git diff --check` — passed

Task 0080 remains blocked until the stale BigQuery documentation is corrected and re-reviewed.
