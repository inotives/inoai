# Heartbeat setup must preserve lock ownership safety

`heartbeat setup` will be an idempotent, active deployment command: it may stop
and unload the known LaunchAgent for its target runtime before installing and
starting the replacement. It must not kill an independently running core or
delete a live, malformed, or unverifiable Runtime Home Lock. Startup may
reclaim only a lock whose recorded owner is proven dead. This keeps one-writer
SQLite ownership safe while still allowing recovery from a genuinely stale
lock. The existing low-level LaunchAgent commands remain unchanged for
diagnostics and manual control; only `heartbeat setup` enables automatic start
and recovery by default. Setup reports success only after a bounded check
confirms the loaded service, supervisor, child, and lock ownership; Discord
readiness and the hourly health check remain separate.
If verification fails, setup rolls back the attempted service change and keeps
diagnostics rather than leaving a failed `KeepAlive` service running.
Because setup changes persistent service state, it requires an explicit
`--connect-dir` target rather than choosing a default runtime home. It does not
build source code or install dependencies; the compiled deployment is a
precondition. Setup validates the entrypoint, target runtime, and lock
ownership before changing persistent service state.
Repeating setup for an already healthy service reconciles configuration without
an unnecessary restart or duplicate LaunchAgent. Configuration drift is
determined by comparing the exact target service's rendered plist.
Setup always enables automatic load and recovery; non-running or manually
controlled services use the lower-level LaunchAgent commands.
The initial command reports sanitized human-readable status only; structured
output is deferred to the existing status extension point.
