# SQLite-default runtime plan

## Goal

Make a fresh inoai deployment run with only its local runtime home and SQLite. PostgreSQL remains available for a later one-way reporting and backup phase, but normal validation, startup, transport handling, and heartbeat health must not depend on it.

## Agreed boundaries

- One Agent Instance owns one runtime-home SQLite database.
- One core process writes that database; the local UI and read-only tools may open it.
- Existing SQLite data is reused when present; a missing database is created through the existing schema path.
- PostgreSQL data is not migrated automatically.
- `POSTGRES_*` settings are no longer required or read by normal runtime startup; leftover keys are tolerated.
- PostgreSQL migration, provisioning, connection-test, and integration commands remain explicit advanced tooling.
- No PostgreSQL sync queue or network exporter is added in this phase.
- The heartbeat checks child liveness, runtime-home lock ownership, and a bounded SQLite query. SQLite WAL/SHM files are normal and are not stale-lock evidence.

## Implementation slices

1. Promote the existing test SQLite adapter into a production `sqlite-operational-store.ts` implementation of `OperationalStore`.
2. Open the runtime home's `inoai.sqlite` during application startup, use the existing schema/migration/recovery path, and close it during shutdown.
3. Remove PostgreSQL from required configuration and normal startup while retaining its modules and explicit commands.
4. Update heartbeat probes, deployment/setup documentation, and the Phase 6c description to describe SQLite authority and future one-way export.
5. Add focused tests for fresh SQLite startup, existing-database reuse, one-writer locking, PostgreSQL-free validation, and SQLite heartbeat failure/recovery behavior.

## Acceptance checks

- A clean runtime home validates and starts without PostgreSQL or Docker.
- Existing SQLite sessions and Memory remain visible after restart.
- A second core for the same runtime home is rejected by the local lock.
- PostgreSQL outage or missing PostgreSQL configuration does not prevent local startup.
- The heartbeat restarts a child that loses SQLite health, but does not restart for ordinary WAL/SHM files.
- Existing PostgreSQL commands still build and remain explicitly opt-in.
