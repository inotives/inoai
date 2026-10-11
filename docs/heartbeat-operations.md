# Heartbeat Supervisor operations

The supervisor is optional. It owns one inoai child and applies the policy in
[ADR 0019](adr/0019-external-heartbeat-supervisor.md). Normal core startup stays
unchanged. The primary test runtime is `.inoai-connect-planner`. Foreground
execution accepts `--connect-dir`; without it, it selects `.inoai-connect`.
LaunchAgent commands default to `.inoai-connect-planner`.

## Prepare and test in the foreground

Run commands from the selected checkout. Use Node.js 22 or newer on macOS.
Build the checkout and configure the selected runtime home with a valid `.env`
and `agent.md`. Provision its PostgreSQL Agent Instance and apply administrator
migrations first. See [PostgreSQL setup](postgres-local.md). The child also
needs its configured Discord bot and authenticated agent CLI.

Stop any existing core or supervisor for this runtime home before starting
another. Unload an existing LaunchAgent before foreground testing. The local
lock and PostgreSQL lease reject duplicate core ownership. A second supervisor
can still start and retry rejected children, so use only one supervisor.

```sh
npm run build
npm run validate -- --connect-dir .inoai-connect-planner
npm run postgres:test -- --connect-dir .inoai-connect-planner
npm start -- heartbeat --connect-dir .inoai-connect-planner
```

The supervisor starts the compiled child directly with Node, without a shell.
The first health check runs 60 minutes after child launch. Checks do not send
Discord requests; the child sends its normal startup notice. Use Ctrl-C or
SIGTERM to stop the supervisor and child. Stop waits for confirmed child exit.

## Logs and failure behavior

```sh
tail -f ~/Library/Logs/inoai/heartbeat.log ~/Library/Logs/inoai/heartbeat-error.log
```

Supervisor records contain timestamps and fixed event names. They exclude raw
driver errors, credentials, environment values, and child output. Child stdout
and stderr are discarded. The LaunchAgent uses these same files for supervisor
stdout and stderr. No log rotation is supplied.

| Condition | Behavior |
| --- | --- |
| Live child, matching local lock, fresh instance lease, successful query | Record `healthy` and check again after 60 minutes. |
| One database or lease failure | Record `degraded` and keep the child. A healthy check resets the failure count. |
| Two consecutive database or lease failures | Record `restart`, stop the child, and start a replacement. Each database probe has a five-second deadline. |
| Proven stale local lock or dead child detected by a health check | Recover without waiting for a second failed check. Startup reclaims only a proven stale lock. |
| Child exit or spawn failure | Retry after ten seconds. Allow three replacement attempts in a rolling five-minute window, then record `retry-limit` and exit with code 1. |
| Missing, malformed, foreign, or unverifiable lock; unverifiable child | Record `health-blocked`, stop the child, and exit with code 1. Do not delete the lock. |
| Child does not exit after SIGTERM | Send SIGKILL after ten seconds. Wait for confirmed exit before any replacement. |

The hourly check cannot prove Discord or agent-provider readiness. A fresh lease
checks the Agent Instance lease, not a child owner token. A probe deadline
returns a timeout result but does not cancel all pending database work. If
SIGKILL produces no exit event, the supervisor retains ownership and waits.

For `health-blocked`, inspect local lock ownership before any manual action.
For database failures, use the selected home's `postgres:test` command and
check PostgreSQL availability and provisioning. For repeated child exits,
unload the service, then run the normal core in the foreground to obtain its
safe startup diagnostics. Do not remove a lock while its owner can still run.

## Optional LaunchAgent installation

These are explicit operator actions. Automated acceptance must not install or
enable the real service.

```sh
npm start -- heartbeat launchagent render --connect-dir .inoai-connect-planner
npm start -- heartbeat launchagent install --connect-dir .inoai-connect-planner
npm start -- heartbeat launchagent status --connect-dir .inoai-connect-planner
```

`render` prints XML without writing files or initializing runtime data.
`install` writes a user plist under `~/Library/LaunchAgents/`, creates the log
directory, and reports the resolved paths. It does not call `launchctl` or load
the service. `RunAtLoad` and `KeepAlive` both default to false. The plist uses
the current Node executable, checkout `dist/index.js`, checkout working
directory, runtime-home name, and user log paths. Its label has the form
`com.inoai.heartbeat.<hash>`; the hash identifies the absolute runtime-home path.
Reinstalling the same target replaces its plist.

To opt into login start or automatic supervisor recovery, pass `--run-at-load`
or `--keep-alive` to `render` or `install`. Unload an already loaded service
before reinstalling with changed options. Installation alone does not update a
loaded service. The supervisor bounds child retries; with KeepAlive enabled,
launchd can restart a failed supervisor under its own throttling.

For manual activation, copy the exact plist path and Label from the installed
plist. Set these shell variables to those values, then load and start it:

```sh
heartbeat_plist='<installed-plist-path>'
heartbeat_label='<Label-from-plist>'
launchctl bootstrap "gui/$(id -u)" "$heartbeat_plist"
launchctl kickstart "gui/$(id -u)/$heartbeat_label"
```

Do this only after the foreground test succeeds and its supervisor has stopped.
When the checkout or Node executable moves, unload and uninstall from the old
checkout first, then build and install from the new checkout. Commands compute
the target from the current checkout and runtime home.

## Service controls

```sh
npm start -- heartbeat launchagent status --connect-dir .inoai-connect-planner
npm start -- heartbeat launchagent stop --connect-dir .inoai-connect-planner
npm start -- heartbeat launchagent unload --connect-dir .inoai-connect-planner
npm start -- heartbeat launchagent uninstall --connect-dir .inoai-connect-planner
```

`status` reports whether the installed service is loaded; it does not prove
child health. `stop` sends SIGTERM to the supervisor and leaves the service
loaded. KeepAlive can restart it. Use `unload` to remove the service from the
launchd domain and prevent that restart. `uninstall` unloads a loaded service
and removes only its plist. Runtime data and logs remain. Missing plists and
installed but unloaded services are safe. A control failure preserves the plist.

## Isolated acceptance checks

Do not read or change repository-root `.inoai-connect*` data in automated tests.
Use temporary deployment and user-home directories. Tests inject clocks,
processes, and service controls; they do not write the real LaunchAgents folder.

```sh
npm run typecheck
npm run build
node --test dist/test/heartbeat*.test.js dist/platform/runtime-home.test.js dist/persistence/postgres*.test.js
npm run postgres:integration
npm test
git diff --check
```

The PostgreSQL integration suite requires both integration URLs and a reachable
local test database. Without `POSTGRES_INTEGRATION_URL`, it reports a skip.
Follow [the opt-in integration setup](postgres-local.md) to rerun it; do not use
the planner's production credentials. A temporary rendered plist can be checked
with `plutil -lint`. A short isolated foreground smoke test can verify a real
child start and SIGTERM shutdown with an injected temporary logger and fixture
configuration. It does not establish live database, Discord, or hourly recovery
acceptance. Record those limits and any environment-gated skips in the handoff.
