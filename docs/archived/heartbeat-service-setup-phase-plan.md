# Heartbeat Service Setup Phase Plan

Status: approved for task creation

## Objective

Add one safe deployment command for the external Heartbeat Supervisor:

```sh
npm start -- heartbeat setup --connect-dir .robin-xai-test
```

The command will install, enable, start, and verify one macOS LaunchAgent for
one explicit Agent Instance. It will make normal Robin deployment simple while
preserving the existing low-level LaunchAgent commands for diagnostics and
manual control.

## Agreed decisions

- `--connect-dir` is required for setup. Setup never selects a default runtime.
- Setup always enables `RunAtLoad` and `KeepAlive`.
- Setup validates the compiled entrypoint, target runtime, and lock ownership
  before changing persistent service state.
- Setup may stop and unload only the known LaunchAgent for the target runtime.
- It must not kill an independently running core process.
- Startup may reclaim only a lock whose owner is proven dead. Malformed or
  unverifiable locks fail closed and are never deleted.
- A healthy, unchanged service is reused without an unnecessary restart.
- Configuration drift is detected by comparing the exact target's rendered
  plist.
- Verification waits at most 10 seconds and confirms the loaded service,
  supervisor, child, and runtime lock ownership. It does not wait for the
  hourly health check or Discord readiness.
- A failed setup rolls back the attempted plist/service change and retains
  diagnostics. It must not leave a failed `KeepAlive` service retrying.
- Setup reports sanitized human-readable output. Structured output is deferred.
- Existing `heartbeat launchagent render|install|status|stop|unload|uninstall`
  behavior remains unchanged.
- Setup does not build source code or install dependencies.

## Current code boundary

`src/inoai/heartbeat/launchagent.ts` already renders a dynamic plist and
provides low-level install and `launchctl` controls. Install intentionally
writes the plist without loading it. The new setup path should compose these
capabilities rather than change the meaning of the existing commands.

## Implementation slices

### Slice 1 — Command contract and preflight

Add `heartbeat setup` parsing and a setup entry point. Require an explicit
`--connect-dir`. Validate the compiled entrypoint and runtime before any
LaunchAgent mutation. Add injected seams for filesystem, process, and
`launchctl` behavior so tests do not touch the user's LaunchAgents directory.

### Slice 2 — Transactional service reconciliation

Render the desired plist with `RunAtLoad` and `KeepAlive` enabled. Compare it
with the installed target plist. Reuse a healthy identical service. For drift,
stop/unload the known target, install the replacement, and retain enough state
to restore the previous plist and service state if setup fails.

### Slice 3 — Activation and bounded verification

Bootstrap and kickstart the target LaunchAgent. Poll for at most 10 seconds to
confirm the service is loaded, the supervisor and child are alive, and the
child owns the runtime lock. Return sanitized status. On failure, roll back the
service change and retain safe diagnostics.

### Slice 4 — Documentation and integrated review

Document setup, rollback, lock conflict behavior, and the distinction between
setup and low-level LaunchAgent commands. Run focused tests, typecheck, build,
architecture checks, diff checks, and an isolated macOS-style smoke test with
fake service controls. Do not enable the real LaunchAgent in automated tests.

## Acceptance criteria

- `heartbeat setup --connect-dir <target>` rejects a missing target.
- Invalid runtime or missing compiled entrypoint causes no LaunchAgent change.
- Setup installs an active target-specific LaunchAgent and starts it.
- Repeating setup on an unchanged healthy service does not restart it.
- A changed plist is replaced transactionally.
- A live independent runtime lock is not killed or deleted.
- A proven stale lock is handled by normal startup recovery.
- Malformed or unverifiable locks fail closed.
- Verification confirms service, supervisor, child, and lock ownership within
  10 seconds.
- Failed setup restores the previous service state or removes the new service.
- Existing low-level LaunchAgent commands retain their current behavior.
- No credentials, lock tokens, child output, or full local secrets appear in
  command output or logs.

## Verification plan

1. Run focused setup and LaunchAgent tests with injected filesystem and
   `launchctl` controls.
2. Run `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
3. Run `git diff --check`.
4. Run an isolated setup smoke test using temporary user-home and runtime
   directories; do not install the real LaunchAgent.
5. Perform one human-controlled live setup only after task review, using an
   explicitly selected runtime.
