# Local PostgreSQL

Local development and opt-in integration tests use the PostgreSQL service in
`docker-compose.yml`:

```sh
docker compose up -d postgres
docker compose ps
docker compose down
```

If `docker compose up` reports that it cannot connect to the Docker API,
start Docker Desktop (or the local Docker-compatible daemon) and rerun the
command. The integration suite is intentionally not silently replaced by a
remote database when local Docker is unavailable.

The service uses development-only defaults (`inoai` database/user and a local
password) and binds to loopback. Override them with `INOAI_POSTGRES_DEV_*`
variables when needed. `docker compose down` preserves the named volume;
remove it explicitly with `docker compose down -v` when discarding local data.

The acceptance suite is opt-in. It never runs as part of `npm test`, and it
does not start or stop Docker for you:

```sh
docker compose up -d postgres
export POSTGRES_INTEGRATION_URL='postgresql://<migration-user>:<password>@127.0.0.1:5432/inoai'
export POSTGRES_INTEGRATION_RUNTIME_URL='postgresql://inoai_sync:<password>@127.0.0.1:5432/inoai'
npm run postgres:integration
docker compose down
```

The migration URL must be able to apply DDL and the runtime URL should use the
restricted `inoai_sync` role; the test refuses to run with an omitted runtime
URL, rejects any runtime role other than `inoai_sync`, and verifies that role
can perform its required DML but cannot create tables. The test provisions two unique Agent Instances,
checks separate schemas and application-enforced isolation, exercises FIFO
queue claiming, Memory and review persistence, verifies lease collision and
refresh behavior, and confirms an unavailable database fails with a safe
error. Test schemas are removed on completion. Do not put either URL in a
committed file or paste it into logs.

Migrations are an explicit administrator action. They do not load a runtime
`.env`, and the normal application never runs DDL:

```sh
npm run postgres:migrate -- --url 'postgresql://<migration-user>:<password>@127.0.0.1:5432/inoai'
```

The URL is supplied only to that invocation. Do not commit it, put it in the
runtime-home `.env`, or paste it into logs. The migration runner tracks applied
files in `public.schema_migrations`, runs files in numeric order, and rejects a
changed checksum. Later migrations add the control and Agent schemas.

At runtime, each Agent Instance also acquires a PostgreSQL lease in
`inoai_control.agent_instance_leases`. `POSTGRES_LEASE_TTL_MS` is the outage
grace period before another process may recover the lease, and
`POSTGRES_LEASE_REFRESH_MS` controls the heartbeat interval. The refresh value
must be lower than the TTL. The local runtime-home `inoai.lock` remains the
fast same-machine guard; the PostgreSQL lease prevents duplicate ownership
across machines. The local lock is a `0600` JSON record containing the owning
PID, macOS process start time, and release token. Startup reclaims it only when
the PID is gone or its start time differs, and otherwise fails closed. Recovery
is startup-only; the lock is not refreshed by a watcher. Legacy UUID-only and
malformed lock files are deliberately not reclaimed because their ownership
cannot be verified safely. See [ADR 0015](adr/0015-runtime-home-lock-stale-recovery.md)
for the recovery decision and [CONTEXT.md](../CONTEXT.md) for the lock/lease
terminology.

Normal startup requires the runtime role to reach PostgreSQL, the numbered
migrations to have been applied by an administrator, and the configured
`AGENT_INSTANCE_ID` to have been provisioned. Startup does not create an
SQLite archive or run DDL. If the Agent Schema is missing, or the lease is
already owned, inoai exits before connecting Discord. Manual Memory commands
use the same PostgreSQL Agent Schema and require the normal runtime `.env`.

SQLite is disposable development data during this cutover; there is no
SQLite-to-PostgreSQL migration or dual-write path. If PostgreSQL is unavailable
at startup or during a store operation, inoai pauses/fails closed and must not
fabricate a Discord reply or replay an uncertain turn.

## Discord allowlist CLI

Add or reactivate a family user for the guild configured in the selected runtime home:

```sh
npm run allowlist:add -- --connect-dir .inoai-connect-planner --user-id <discord-user-id> --display-name "Ada"
```

Disable a family user without deleting its audit history:

```sh
npm run allowlist:disable -- --connect-dir .inoai-connect-planner --user-id <discord-user-id>
```

The commands are idempotent, default to the `family` role, and never print
credentials or PostgreSQL driver errors. The configured owner cannot be changed
by these commands. In DBeaver, inspect the result in the provisioned Agent
Schema's `users` table, for example:

```sql
SELECT external_user_id, display_name, role, state
FROM agent_inoai_planner.users
WHERE transport = 'discord'
ORDER BY id;
```
