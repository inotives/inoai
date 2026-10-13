# SPA Agent UI phase plan

## Purpose

Build a local, read-only single-page web UI for one deployed Agent Instance.
The UI gives the owner a stable operational view of the selected instance's
SQLite archive without exposing credentials or requiring a central database.

## Launch contract

```text
inoai ui --connect-dir .robin-xai-test --port 8989
```

- `--connect-dir` selects the deployed Agent Instance and is resolved
  dynamically from the launch folder.
- The default port is `8989`; `--port` overrides it.
- Bind to `127.0.0.1` by default. Remote access and authentication are out of
  scope for this phase.
- The UI reads only the selected instance's SQLite database. It never reads or
  renders `.env` contents.

## Visual direction

- Dark theme using Tailwind CSS and daisyUI.
- Structure the page like the AWS study-guide reference: persistent metrics,
  tabbed categories, tables, and expandable detail areas.
- Keep the agent profile panel at the top while the active tab changes.
- Auto-refresh is targeted to the profile and health panels. It must not reset
  the active tab, scroll position, filters, or expanded rows.
- The refresh control is an accessible icon toggle: green when enabled and
  grey when disabled, with tooltip and `aria-pressed` state.

## Initial tabs

1. **Overview** — profile, a compact 24-hour health timeline, rendered
   `agent.md` content, and the local skills/tools list.
2. **Conversations** — four message/session metrics followed by searchable
   message history with state and created-at filters, expandable bodies, and
   session context. The separate Sessions tab is removed.
3. **Memory** — searchable active memories with created-at filters, origin and
   state, a memory-review status, and expandable review/memory details.

## Agent profile

The persistent profile panel may show agent name or instance ID, provider,
transport, runtime status, uptime, last heartbeat, SQLite health, and the
runtime folder name. It must not show credentials, tokens, raw Discord IDs,
lock tokens, or full filesystem paths.

## Health timeline

The UI will show a rolling 24-hour timeline with 24 hourly positions:

- Green: healthy.
- Amber: degraded.
- Red: restart or health-blocked.
- Grey: unknown, missing, or not yet observed.
- Recovery and restart markers remain visible.
- Missing observations are never interpolated.
- Hover details contain only sanitized status fields and safe reason categories.
- Timestamps are stored in UTC and displayed in the browser's local timezone.

The heartbeat supervisor will persist one sanitized `heartbeat_check` event per
successful database check in the existing SQLite `events` table. Details use
compact JSON for status, child, lock, query, and action fields. If SQLite is
busy or unavailable, event persistence is best-effort: the supervisor keeps
the local heartbeat log as fallback evidence and writes recovery context after
SQLite becomes available. Heartbeat event history is retained indefinitely;
the UI queries only the latest 24 hours for the timeline.

## Data and safety boundaries

- SQLite remains the local source of truth.
- The first version reuses the existing `events`, `messages`, `sessions`, and
  `memories` tables; no central PostgreSQL dependency is introduced.
- All queries are read-only from the UI path.
- UI responses and hover details are filtered to prevent secrets, raw provider
  traces, Discord metadata, lock tokens, and local absolute paths from being
  exposed.
- Normal SQLite writes retain the existing 5-second busy timeout. Health event
  persistence must not turn ordinary write contention into a restart decision.

## Scope for this phase

- Local SPA server and `inoai ui` launch options.
- Dark responsive layout and tab navigation.
- Fixture-driven static SPA prototype for human review before live data wiring.
- Read-only SQLite query boundary for the selected runtime home.
- Profile, metrics, tables, filters, and targeted refresh behavior.
- Heartbeat event persistence and health timeline rendering.
- Focused tests for query safety, refresh stability, SQLite contention, and
  health recovery states.

## Prototype gate

Before the SPA reads live SQLite data, build and review a fully navigable
fixture-driven prototype. The prototype must cover all six tabs, the persistent
profile panel, the 24-hour health timeline, refresh behavior, loading, empty,
error, hover/focus, and responsive states. It must not read SQLite, `.env`,
Discord, or runtime files.

The implementation order is:

1. Local SPA launch and static shell.
2. Fixture-driven prototype and human review.
3. Read-only SQLite data boundary.
4. Profile, Overview, operational tabs, and health timeline backed by live data.

The planner must not unblock live data work until the prototype review is
approved. The workflow graph will be repaired with AgentRig's supported task
dependency command when available.

## Deferred

- Remote access, authentication, and multi-user access.
- PostgreSQL synchronization or centralized reporting.
- UI mutations such as agent configuration, message sending, or memory edits.
- Detailed visual polish, advanced chart interactions, exports, and custom
  dashboards.
- Additional agents or cross-instance comparison in one UI session.

## Completion criteria

- The UI starts on port `8989` by default and accepts a custom port.
- The selected runtime folder is the only database loaded.
- The fixture-driven prototype is approved before live data wiring begins.
- All six tabs render safely from local SQLite data.
- The profile and health panels refresh independently without page jumps.
- Heartbeat events support a truthful rolling 24-hour timeline, including
  missing data and recovery markers.
- No credentials, raw Discord metadata, lock tokens, or full local paths are
  exposed in the UI or committed fixtures.
- Focused tests, typecheck, build, and diff checks pass.
