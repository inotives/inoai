---
id: task-0079
title: macOS launchd supervisor fallback
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: medium
parent: ""
depends_on:
  - task-0078
blocked_reason: Reviewer found README substitutes a relative CONNECT_DIR despite
  the task requiring explicit runtime-home paths; also fix the placeholder-count
  wording. Plist, secrecy, lock guidance, and non-GUI test limitation otherwise
  pass.
blocked_on: 2026-10-03
message: "Re-review clean: absolute runtime-home path, six placeholders, plist
  validation, no secrets, duplicate lock/manual boundary, and honest non-GUI
  launchctl limitation verified."
---








# Task

## Goal

Restart inoai automatically after a process crash or machine restart.

## Scope

- Add a macOS launchd template/documented installer for a selected runtime home.
- Use explicit executable/runtime-home paths and a safe log location.
- Do not store or print `.env` contents or credentials.
- Keep launchd optional; normal manual startup remains supported.
- Document unload/stop/remove commands and avoid duplicate instances.

## Acceptance Criteria

- [ ] KeepAlive restarts a crashed process in a disposable deployment test.
- [ ] The template cannot launch two cores against one runtime home.
- [ ] Setup and removal steps are documented.
- [ ] No secrets appear in the plist or logs.

## Blockers

- 2026-10-03: Reviewer found README substitutes a relative CONNECT_DIR despite the task requiring explicit runtime-home paths; also fix the placeholder-count wording. Plist, secrecy, lock guidance, and non-GUI test limitation otherwise pass.
