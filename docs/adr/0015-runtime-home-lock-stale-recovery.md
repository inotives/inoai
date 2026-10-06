# ADR 0015: Recover stale runtime-home locks by process identity

## Status

Accepted for the runtime-lock recovery fix on the macOS V1 target. AgentRig
tasks `task-0085` through `task-0088` track implementation, verification,
documentation, and final review.

## Context

The runtime home keeps a local `inoai.lock` file as a fast same-machine guard,
while PostgreSQL owns the cross-machine Agent Instance lease. The existing lock
contains only a random token. If inoai is force-killed or the machine shuts down,
the token can remain even though no process owns the runtime home, requiring
manual deletion before restart.

## Decision

The lock file will contain JSON metadata with the owning process PID, the process
start time, and a random release token. When startup encounters an existing lock,
inoai will inspect the PID and process start time using macOS process metadata.
It may reclaim the lock only when the recorded process is gone or its start time
does not match. If process identity cannot be verified, startup fails closed.

Recovery runs only during startup. The lock is not refreshed by a background
watcher; the PostgreSQL lease heartbeat remains responsible for live ownership
and cross-machine recovery. Legacy UUID-only or malformed lock files are not
reclaimed automatically because their owner cannot be verified safely.

## Consequences

Unexpected termination no longer requires routine manual lock deletion after the
new lock format is established. A lock held by a live process remains protected,
and PID reuse is rejected when the recorded start time differs. A legacy lock
left by an older inoai version may still require one manual cleanup. The local
lock remains supplementary; PostgreSQL lease acquisition is still required.
