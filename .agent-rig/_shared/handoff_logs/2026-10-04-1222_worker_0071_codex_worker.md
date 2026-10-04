---
agent: worker_0071
role: worker
tool: codex
task: task-0071
task_title: "Phase 6c: PostgreSQL driver, configuration, and OperationalStore contract"
status: handoff
---

## Completed

- Added required, secret-safe validation for `POSTGRES_URL` and the lowercase `agent-` `AGENT_INSTANCE_ID` slug.
- Added bounded pool settings with defaults for pool size, connect timeout, idle timeout, and query timeout.
- Added `createPostgresPool` using the validated settings and the `pg` dependency already introduced for this phase.
- Added the async `OperationalStore` contract covering startup recovery, users/sessions, queue and delivery operations, events, Memory, reviews, and shutdown.
- Exported the database input types needed to implement the contract in later tasks.
- Added focused configuration and pool/contract tests and updated existing configuration fixtures with the new required settings.
- BigQuery code was not changed.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test dist/test/config.test.js dist/test/postgres.test.js` — 13 passed.
- `git diff --check` — passed.
- `npm test` — 195 passed, 1 pre-existing failure: `dist/test/bigquery.test.js` cannot import `@google-cloud/bigquery` because that dependency is absent from the installed node_modules. This is outside task-0071 and no BigQuery code was modified.

## Residual risks

- PostgreSQL migrations, provisioning, schema/grants, store implementation, and application wiring remain for downstream tasks.
- Runtime error sanitization and connection lifecycle behavior should be reviewed when the pool is wired into startup.
- The existing BigQuery dependency/install failure remains isolated and deferred as planned.
