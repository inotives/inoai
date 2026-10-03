---
agent: worker
role: worker
tool: codex
task: task-0080
task_title: Runtime recovery integrated review and acceptance
status: review
---

## Summary

Corrected the stale Phase 6c documentation identified by the integrated reviewer.

- README now states that `@google-cloud/bigquery` is bundled, the ADC-backed client is created when configured, and the scheduler starts and stops with the core.
- README now distinguishes offline fake-sink coverage from live cloud prerequisites and records that live `launchctl` KeepAlive behavior was not exercised in this non-GUI environment.
- ADR 0012 now records the implemented production client and `src/index.ts` lifecycle wiring while retaining optional/non-blocking semantics and the offline-test credential boundary.
- The phase plan now records the production client, ADC, scheduler startup/shutdown, and live-cloud setup boundary accurately.

## Verification

- `git diff --check -- README.md docs/adr/0012-optional-one-way-bigquery-analytics-sync.md docs/implementation-phases.md` — passed.
- Documentation-only scope; no commit or push performed.
