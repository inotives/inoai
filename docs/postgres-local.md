# Advanced PostgreSQL tooling

Normal runtime startup uses the selected runtime home's `inoai.sqlite`. SQLite
is the local source of truth. Fresh setup requires neither PostgreSQL nor Docker.
Normal validation and startup ignore `POSTGRES_*` settings, including leftover keys.
Existing SQLite data is reused; a missing database is created through the existing
schema path. There is no automatic PostgreSQL-to-SQLite migration.

A later phase will send an asynchronous, one-way, redacted SQLite-to-PostgreSQL
copy for central reporting and backup. PostgreSQL will not own live work or
block local startup. No sync queue, exporter, or dual writes are implemented in
this phase. See [ADR 0020](adr/0020-local-sqlite-source-of-truth.md).

The existing `postgres:*` commands are explicit advanced/future tools.
Opt-in PostgreSQL development and integration tests use the service in
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
`.env`, and normal startup never runs PostgreSQL DDL:

```sh
npm run postgres:migrate -- --url 'postgresql://<migration-user>:<password>@127.0.0.1:5432/inoai'
```

The URL is supplied only to that invocation. Do not commit it, put it in the
runtime-home `.env`, or paste it into logs. The migration runner tracks applied
files in `public.schema_migrations`, runs files in numeric order, and rejects a
changed checksum. Later migrations add the control and Agent schemas.

## Explicit provisioning and connection test

Generate provisioning SQL for an advanced PostgreSQL test instance, then apply
it with an administrator SQL client:

```sh
npm run postgres:provision -- \
  --agent-instance-id agent-inoai-planner \
  --agent-name "inoai planner" \
  --agent-provider codex \
  --runtime-home .robin-xai-test \
  --owner-user-id <discord-user-id> > provision.sql
```

`postgres:test` explicitly reads `POSTGRES_URL` from the selected home's `.env`.
Add that key only when using this advanced tool. Do not use administrator
credentials there. The key does not select PostgreSQL for normal startup:

```sh
npm run postgres:test -- --connect-dir .robin-xai-test
```

The retained PostgreSQL store and integration tests exercise leases in
`inoai_control.agent_instance_leases`. Those leases do not control the current
SQLite runtime or its [Heartbeat Supervisor](../INSTRUCTIONS.md).

One core process owns each runtime home and holds its local `inoai.lock`; do not
share a runtime home between machines. The supported allowlist and Memory CLI
commands below can run while the core is active through a short-lived
maintenance connection. SQLite serializes writes: a maintenance write waits up
to 5 seconds, then reports a retryable busy error. Retry it manually. Allowlist
changes apply to later authorization checks; Memory changes apply to later
prompt composition and do not alter an already-composed Turn. `memory list` is
read-only. The UI remains read-only; other live database writes, IPC, and
direct SQLite edits are not supported. Startup reclaims only locks proven
stale by process identity. WAL/SHM files are normal SQLite artifacts, not
stale locks.

## Discord allowlist CLI

Add or reactivate a family user for the guild configured in the selected runtime home:

```sh
npm run allowlist:add -- --connect-dir .robin-xai-test --user-id <discord-user-id> --display-name "Ada"
```

Disable a family user without deleting its audit history:

```sh
npm run allowlist:disable -- --connect-dir .robin-xai-test --user-id <discord-user-id>
```

The commands are idempotent, default to the `family` role, and never print
credentials or raw database errors. The configured owner cannot be changed
by these commands. They use the selected runtime home's SQLite database and
can run while its core is active. Use the retry guidance above if a write
reports that SQLite is busy. Inspect its `users` table, for example:

```sql
SELECT external_user_id, display_name, role, state
FROM users
WHERE transport = 'discord'
ORDER BY id;
```

## Memory CLI

List active Memory without changing database state:

```sh
npm start -- memory list --connect-dir .robin-xai-test
```

Add or soft-delete a manual Memory entry while the runtime is active:

```sh
npm start -- memory add "Remember this for later" --connect-dir .robin-xai-test
npm start -- memory delete <id> --connect-dir .robin-xai-test
```

Adds and deletes affect later prompt composition. They do not change a Turn
whose prompt has already been composed.
