# Local SQLite is the runtime source of truth

inoai will use one SQLite database inside each Agent Instance's runtime home as the authoritative operational store for local startup, conversations, queue state, Memory, reviews, events, and recovery. PostgreSQL is retained as future tooling only and will later receive an asynchronous, one-way, redacted reporting and backup copy; it will not be required for startup, participate in live ownership, or control local work. This keeps a fresh deployment service-free and avoids split-brain or network-outage failures while preserving a clear path to centralized reporting.

## Consequences

- One core process writes one runtime-home SQLite file; local UI/read-only tools may inspect it.
- Existing SQLite schema creation, migration, WAL, busy-timeout, recovery, audit fields, and stable IDs remain in use.
- Existing PostgreSQL commands and implementation remain available as advanced/future tooling but are unwired from normal validation and startup.
- No automatic PostgreSQL-to-SQLite migration is attempted; a future exporter owns SQLite-to-PostgreSQL synchronization.
