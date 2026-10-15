# Runtime SQLite writes while Robin is running

## Observation

The supported allowlist command cannot currently add a family user while Robin
is running from the same runtime home. The command fails with
`Runtime home is already locked` because it enters the normal runtime startup
path and cannot acquire the runtime-home process lock.

This observed error is the inoai runtime lock, not SQLite's `SQLITE_BUSY`
response. The runtime lock prevents a second inoai process from opening the
same runtime home. SQLite's single-writer behavior remains a separate
constraint that any live-write solution must handle safely.

## Impact

Operators have to stop Robin, run the allowlist command, and restart Robin.
This creates avoidable downtime and makes ordinary runtime administration less
clear. Other supported local commands that write to the same SQLite database
may have the same limitation; verify each command before treating it as
affected.

## Verified evidence

- With Robin's LaunchAgent loaded and its runtime process active,
  `npm run allowlist:add -- --connect-dir .robin-xai-test ...` failed with
  `Runtime home is already locked`.
- After unloading the LaunchAgent and confirming the processes had stopped, the
  same supported command added the requested family users successfully.
- No direct SQLite edits were used.

## Required outcome

Provide a supported way to perform authorized runtime-home database writes
while Robin remains running. The solution must coordinate writes with the live
runtime, preserve the single-runtime lock guarantee, and avoid lost or
partially-applied updates when a Discord message is being handled.

## Agreed design direction

Keep the Runtime Home Lock for the full lifetime of the running Agent
Instance. It protects single-runtime ownership; it is not a SQLite write lock.
Supported local administrative commands will use a short-lived maintenance
connection to the same SQLite database instead of starting a second runtime.
SQLite transactions and its configured busy timeout will coordinate database
writes. Use the existing 5-second busy timeout; if the maintenance command
cannot acquire its transaction within that limit, return a clear retryable
error instead of waiting indefinitely. This avoids adding a Robin IPC or
Discord administration path.

The initial scope is allowlist add/disable and the local Memory CLI's add,
delete, and list operations. The list operation is read-only. Other commands
that write to runtime data need separate review before they use this path. Do
not bypass or weaken the Runtime Home Lock.

## Runtime impact boundary

Robin must not be stopped or restarted for a maintenance write. A short wait
for a SQLite transaction is acceptable, but the operation must not cause a
Discord message or Turn to be lost or fail, or change the behavior of an
in-flight Turn. Updates apply to subsequent authorization checks and Turns.

## Acceptance checks for a future fix

- Add or update an allowlist user through the supported interface while Robin
  remains running.
- Add and delete a Manual Memory Entry through the supported interface while
  Robin remains running.
- List Memory through the supported CLI while Robin remains running, without
  changing database state.
- Verify the change is visible to subsequent authorization checks without
  restarting Robin; a message already authorized before a disable completes
  with its existing decision.
- Exercise an administrative write while a Discord message is being handled;
  confirm both operations complete safely, the message/Turn is not lost or
  failed, and the database remains consistent.
- Verify a Memory change affects subsequent Turns without changing an
  in-flight Turn whose prompt has already been composed.
- Keep the existing single-runtime lock protection and verify ordinary CLI
  writes still work when Robin is stopped.
