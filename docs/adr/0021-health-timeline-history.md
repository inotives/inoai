# Persist heartbeat history for the 24-hour health timeline

The read-only agent UI will show a rolling 24-hour health timeline with one
hourly position per heartbeat interval. The heartbeat supervisor will write a
sanitized `heartbeat_check` event to the Agent Instance's SQLite `events` table
after each successful database check. Event details use compact JSON containing
the combined status, child status, lock status, database status, and action.

If SQLite cannot accept the event because it is temporarily busy or
unavailable, the supervisor will not treat the telemetry write as a liveness
failure. It will retain the existing local heartbeat log as fallback evidence.
After recovery, it will write a recovery event with the preceding failure
context when SQLite is available again. Heartbeat events are retained
indefinitely; the UI queries only the latest 24 hours.

The timeline uses green for healthy, amber for degraded, red for restart or
blocked, and grey for unknown or not-yet-observed hours. Missing observations
are never interpolated. Restart and recovery markers remain visible, while
hover details expose only sanitized status fields and safe reason categories.
The Overview shows a compact timeline and the Health tab provides the detailed
timeline and event list. Timestamps are stored in UTC and displayed in the
browser's local timezone.

## Consequences

- SQLite remains the source of truth for durable health history.
- The existing `events` table and schema are reused; no health-history table is
  required for the first implementation.
- Heartbeat telemetry cannot cause an unnecessary restart because event-write
  contention is handled separately from the health decision.
- A database outage may produce a grey gap until a recovery event is written.
- The existing 5-second SQLite busy timeout remains unchanged for normal
  application writes and health probes.
