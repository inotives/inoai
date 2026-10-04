# ADR 0014: PostgreSQL as the operational source of truth

## Status

Accepted for the PostgreSQL migration and implementation scope. Phase 6c is tracked by AgentRig tasks 0071–0081, with task 0080 as the final integrated review.

## Context

SQLite's single-file locking model is becoming a limiting factor as inoai grows toward multiple cooperating Agent Instances, shared task assignment, and scheduled work. A one-way PostgreSQL analytics sink would not remove that operational contention or provide a shared coordination store.

## Decision

PostgreSQL will become the operational source of truth for Agent Instances, Conversations, Turns, Memory, reviews, events, and future Tasks. The system will require a reachable PostgreSQL database for normal operation. Existing SQLite archives are disposable development data for this cutover; preserving or migrating them is explicitly out of scope.

The database will be shared by cooperating Agent Instances. A shared `inoai_control` schema owns Agent Instance registration, task assignment, schedules, leases, and coordination. Each Agent Instance has its own schema for Conversations, Messages, Memory, Reviews, and Events. `AGENT_INSTANCE_ID` is a lowercase `agent-` slug using letters, digits, and hyphens, bounded to PostgreSQL's 63-character identifier limit and unique after normalization. The provisioning factory derives the underscore form for the Agent Schema. Database migrations run explicitly with a privileged role; runtime agents use restricted DML roles.

Production deployments may connect to a reachable PostgreSQL service on the owner's network. Local development and automated tests use a Docker Compose PostgreSQL service so they do not depend on that network database. A local provisioning factory accepts an Agent Instance identity and emits a reviewable DBeaver SQL script; it never needs PostgreSQL admin credentials itself.

All trusted Agent Instances use the shared `inoai_sync` runtime role. Provisioning grants that role only the required DML on the control schema and provisioned Agent Schemas. Because PostgreSQL privileges are role-wide for this shared login, the current `POSTGRES_ISOLATION_MODE=application` policy enforces Agent Schema ownership in the application: it validates the configured Agent Instance slug, derives the only permitted schema, and rejects cross-Agent schema targets. `database` mode is reserved and rejected until database-enforced isolation is implemented. Cross-agent collaboration will use explicit control-plane Tasks or handoffs in a later phase. A PostgreSQL lease/advisory lock supplements the local runtime-home lock so one Agent Instance cannot be active on two machines at once.

The async `OperationalStore` boundary owns Conversations, queue work, Memory, reviews, events, and Manual Memory CLI operations. The Electron UI remains deferred to Phase 7. Unit tests use a fake store; opt-in Docker integration tests exercise the real migrations, provisioning, leases, and operations.

## Consequences

PostgreSQL outages pause safe operational work unless a later offline queue/fallback is designed. The database layer must become asynchronous and connection-pooled, replacing the current synchronous `node:sqlite` access patterns. Existing SQLite data will not be migrated. BigQuery changes are isolated and deferred; this phase does not redesign or rewire the BigQuery exporter. The Electron UI remains on the Phase 7 track and will be migrated after the core operational store is stable.
