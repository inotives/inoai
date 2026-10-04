# ADR 0013: Optional PostgreSQL analytics sink

## Status

Accepted for Phase 6c PostgreSQL analytics sync.

## Context

SQLite remains inoai's operational source of truth. The project also needs an optional one-way analytics copy that can target PostgreSQL hosted locally, in a container, or on a reachable private network. PostgreSQL schema changes must not be available to the normal runtime sync role.

The current PostgreSQL deployment is on a private local network and presents a self-signed certificate. Strict certificate validation would require distributing a CA file before the first local sync.

## Decision

- Mirror the existing six analytics tables used by BigQuery.
- Keep PostgreSQL sink state, watermarks, and retry backoff independent from BigQuery.
- Disable the sink when its optional configuration is absent or invalid; PostgreSQL failures never block local chat or Memory Reviews.
- Use a dedicated `inoai_sync` role with database connect, schema usage, and table DML privileges only. Run migrations separately with a privileged role.
- Configure the sink with a runtime-home `POSTGRES_URL` and interval setting.
- Use encrypted PostgreSQL transport with lenient certificate validation for this private-network deployment. Add CA-based validation as a later hardening option.

## Consequences

The local network deployment can connect without distributing a CA bundle, but certificate authenticity is not verified. The runtime role cannot create or alter tables. PostgreSQL remains an analytics destination, not the operational database or scheduler store.
