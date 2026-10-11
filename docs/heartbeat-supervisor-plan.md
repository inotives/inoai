# Heartbeat Supervisor implementation plan

Status: proposed

## Objective

Add an external Heartbeat Supervisor for inoai. The supervisor runs as a
user-level macOS `launchd` LaunchAgent, starts one inoai child process, checks
the child and its operational ownership state once per hour, and restarts the
child when recovery is safe.

The first deployment target is `.inoai-connect-planner`. The command remains
usable with another runtime home through `--connect-dir`.

## Decisions

- The supervisor is external to the normal inoai process.
- The existing TypeScript executable provides a foreground command such as
  `npm start -- heartbeat --connect-dir .inoai-connect-planner`.
- A user-level `launchd` LaunchAgent is supported but is not enabled by
  default.
- The installer renders the repository path, executable path, runtime-home
  path, and log paths at install time. No machine-specific absolute path is
  committed.
- The health interval is fixed at 60 minutes for the first version.
- A healthy check requires all of the following:
  - the inoai child process is alive;
  - the runtime-home lock belongs to that live process;
  - the PostgreSQL lease is fresh;
  - a lightweight PostgreSQL query succeeds within 5 seconds.
- A dead child or proven stale runtime-home lock triggers immediate recovery.
- Two consecutive PostgreSQL or lease failures are required before recovery.
- Lock recovery reuses the existing PID and process-start-time proof. A
  malformed or unverifiable lock fails closed and is never deleted by the
  supervisor.
- Recovery sends `SIGTERM`, waits 10 seconds, then sends `SIGKILL` if the
  child remains alive.
- Repeated child exits wait 10 seconds between attempts and stop after three
  attempts within five minutes. The failure is logged for `launchd` to handle
  if automatic supervisor recovery is enabled.
- Supervisor logs go to `~/Library/Logs/inoai/heartbeat.log` and
  `~/Library/Logs/inoai/heartbeat-error.log`.
- Restart events remain local. The restarted inoai process emits its normal
  Discord startup status.

## Scope

### Included

- A heartbeat supervisor capability with injectable timing and process
  dependencies for deterministic tests.
- Child process start, health checks, graceful shutdown, bounded restart, and
  supervisor exit behavior.
- A CLI entry point that runs the supervisor in the foreground.
- A value-free `launchd` plist template and an explicit installer or render
  command.
- Tests for healthy operation, stale-lock safety, database failure tolerance,
  child restart behavior, retry limits, and dynamic path rendering.
- README and operational documentation for install, start, stop, status,
  logs, and uninstall workflows.

### Excluded

- Enabling the LaunchAgent on the current machine.
- A system daemon or root installation.
- Discord API calls from the supervisor.
- Automatic deletion of malformed or unverifiable locks.
- A configurable heartbeat interval or retry policy.
- A second runtime deployment beyond `.inoai-connect-planner`.
- Changes to PostgreSQL schema, lease semantics, or normal inoai conversation
  behavior.

## Proposed implementation shape

1. Add a small `src/heartbeat/` capability boundary for supervisor policy,
   health results, timing, and child lifecycle. Reuse platform runtime-home
   lock inspection and persistence PostgreSQL helpers instead of duplicating
   lock or lease rules.
2. Extend the existing CLI parser in `src/app/application.ts` with the
   foreground heartbeat command and its `--connect-dir` handling. The
   supervisor starts the compiled inoai executable directly with Node rather
   than invoking a shell or `npm`.
3. Add a `launchd` template and a renderer/installer that resolves paths from
   the current checkout at install time. Keep `RunAtLoad` and `KeepAlive`
   available as explicit options, disabled by default.
4. Keep the first operational check implementation narrow: process identity,
   runtime-home lock state, PostgreSQL lease/query health, and local logging.

## Task slices

### Slice 1 — Health model and probes

Define health results and implement the child, runtime-home lock, PostgreSQL
lease, and query probes. Reuse existing lock identity validation and lease
contracts. Add tests for healthy state, dead process, stale lock, malformed
lock, lease failure, query timeout, and the two-failure threshold.

Verify with the focused heartbeat and existing runtime-home/PostgreSQL unit
tests.

### Slice 2 — Supervisor lifecycle and CLI

Implement the supervisor loop, child spawning, `SIGTERM`/`SIGKILL` shutdown,
10-second retry delay, three-attempt/five-minute bound, and local log output.
Expose the foreground `heartbeat` command with `--connect-dir`.

Verify with fake child processes and injected clocks. Confirm the normal inoai
command path remains unchanged.

### Slice 3 — Dynamic LaunchAgent installation

Add the value-free plist template and explicit render/install lifecycle. Render
the current executable, repository, runtime-home, and log paths dynamically.
Support status, stop, unload, and uninstall operations without enabling the
service automatically.

Verify rendered plist paths, disabled default flags, install idempotence, and
safe behavior when the target plist is absent.

### Slice 4 — Operational documentation and integrated review

Document foreground testing, optional LaunchAgent installation, log locations,
manual service controls, failure behavior, and the `.inoai-connect-planner`
test target. Run the full focused acceptance checks and review the integrated
diff for credential exposure, duplicate Agent Instance ownership, stale-lock
recovery safety, and unrelated changes.

## Acceptance criteria

- `npm start -- heartbeat --connect-dir .inoai-connect-planner` starts one
  supervisor and one inoai child.
- The supervisor performs the fixed hourly check without requiring Discord
  API access of its own.
- A proven stale runtime-home lock is recovered safely; an unverifiable lock
  fails closed.
- One transient PostgreSQL or lease failure does not restart the child.
- Two consecutive PostgreSQL or lease failures trigger a graceful child
  restart.
- A child that exits repeatedly is bounded and leaves a useful local error
  record.
- The generated LaunchAgent contains dynamic absolute paths for the current
  machine and does not enable login start or KeepAlive by default.
- No credentials, PostgreSQL URLs, or environment values appear in logs,
  plist output, or committed files.
- Existing tests and normal `npm start -- --connect-dir ...` behavior remain
  valid.

## Verification plan

1. Run focused heartbeat tests and the existing runtime-home and PostgreSQL
   tests.
2. Run `npm run typecheck`, `npm run build`, and `git diff --check`.
3. Render the planner LaunchAgent into a temporary directory and inspect all
   paths and flags.
4. Run a foreground supervisor smoke test against an isolated temporary
   runtime home; do not enable or install the real LaunchAgent.
5. Run the full test suite if the focused checks pass.

## Risks and mitigations

- A false stale-lock decision could create duplicate ownership. Reuse the
  existing process-identity proof and fail closed on uncertainty.
- A database outage could cause unnecessary restarts. Require two consecutive
  failures and use the 5-second query timeout.
- A child crash loop could consume resources. Bound attempts and rely on
  `launchd` throttling only when the user explicitly enables it.
- A rendered plist could point to the wrong checkout. Resolve and display the
  paths during explicit installation, and test rendering in a temporary
  directory.
