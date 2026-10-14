# IP-0001 — Runtime SQLite live administration

## Context

The allowlist and Memory CLI commands call the normal runtime startup path.
When an Agent Instance is already running, that path cannot acquire its
Runtime Home Lock and returns `Runtime home is already locked`. The command is
blocked before it performs the requested database operation. This is a
runtime-ownership lock conflict, not SQLite returning `SQLITE_BUSY`.

The SQLite adapter already uses WAL mode and a 5-second busy timeout. Runtime
database writes use short transactions. The Runtime Home Lock is held for the
life of the Agent Instance to prevent a second runtime from taking over the
same Discord identity.

## Goal

Allow supported local administration commands to read or update the selected
Agent Instance's SQLite database while its runtime remains active, without
restarting the runtime or losing/failing a Discord message or Turn.

## Accepted decisions

- Keep the Runtime Home Lock for the full lifetime of the Agent Instance. It
  protects runtime ownership; it is not a database write lock.
- Use a short-lived local SQLite connection for administration commands,
  rather than sending operations through Robin or adding IPC/Discord admin
  commands.
- Let SQLite transactions coordinate the runtime and maintenance connections.
  A brief transaction-level wait is acceptable.
- Reuse the current 5-second SQLite busy timeout. If an administration command
  cannot acquire its transaction within that limit, return a clear retryable
  error. Do not queue indefinitely.
- Apply committed allowlist changes to later authorization checks and Memory
  changes to later prompt composition. Do not alter an already-authorized
  message or an in-flight Turn whose prompt is already composed.

## Scope

- Allowlist add and disable commands.
- Manual Memory add and delete commands.
- Memory list, as a read-only command, so the local Memory CLI remains usable
  while the runtime is active.
- Preserve existing command syntax, `--connect-dir` path selection,
  validation, actor/audit fields, soft deletion, and output behavior.
- Keep the maintenance connection short-lived and close it on success and
  failure.
- Preserve current behavior for a stopped or newly initialized runtime home.
- Update operator guidance that currently says to stop inoai before local
  database writes.

## Out of scope

- Releasing or weakening the Runtime Home Lock while Robin is running.
- A general-purpose database API, IPC server, Discord administration command,
  or second Agent Runtime process.
- Other database-writing commands until each is reviewed for this access path.
- Schema changes, migrations, PostgreSQL sync, UI write access, or changes to
  normal conversation and heartbeat write behavior.

## Implementation outline

1. Add a narrow maintenance database-opening path that resolves and validates
   the selected runtime home but does not acquire the Runtime Home Lock or run
   runtime startup recovery while the Agent Instance is active. Preserve safe
   initialization/migration behavior when the runtime is stopped, and fail
   closed if the home or database cannot be safely opened.
2. Route the in-scope allowlist and Memory CLI operations through that path and
   the existing operational-store methods. Keep database transactions short;
   perform no prompts, network calls, or other slow work while a write
   transaction is open.
3. Map a busy timeout to a non-secret, retryable CLI error. Always close the
   maintenance connection and leave the running process and lock untouched.
4. Update `AGENTS.md`, `docs/implementation-phases.md`, and relevant command
   documentation to describe which local commands can safely run while an
   Agent Instance is active.

## Acceptance criteria

- Each in-scope command works while a live Agent Instance owns the Runtime
  Home Lock; the lock owner and runtime process remain unchanged.
- The allowlist change is visible to the next authorization check, and
  Memory changes are visible when a later Turn's prompt is composed. An
  already-authorized message or already-composed Turn continues unchanged.
- A read-only Memory list works while the runtime is active and does not
  change database state.
- Concurrent maintenance and runtime writes serialize safely. A message being
  handled is neither lost nor failed, and the database remains consistent.
- A maintenance operation blocked for 5 seconds returns a clear retryable
  error, makes no partial change, and does not stop or restart the runtime.
- Existing local commands continue to work when the runtime is stopped,
  including expected fresh-home initialization behavior.
- Existing user validation, audit fields, and soft-delete behavior remain
  intact; no credentials or raw Discord identifiers are added to logs.
- Tests use isolated temporary runtime homes and never access developer
  runtime data.

## Verification

- Unit-test path validation, maintenance connection lifecycle, operation
  validation, audit fields, and busy-error mapping.
- Integration-test a running process holding the Runtime Home Lock while each
  administration command executes against the same temporary SQLite file.
- Exercise both transaction orderings: runtime write first, then maintenance;
  maintenance write first, then runtime. Verify both complete without a lost
  or failed message.
- Hold a write transaction past the 5-second timeout in an isolated test and
  verify the maintenance command fails cleanly without a partial update.
- Run focused tests, typecheck, build, and full test suite; inspect the final
  diff and update the operator documentation.
