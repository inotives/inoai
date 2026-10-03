---
agent: reviewer
role: reviewer
tool: codex
task: task-0079
task_title: macOS launchd supervisor fallback
status: blocked
---

## Findings

1. **Medium — runtime path is not explicit in the documented installer.** `README.md:113-131` sets `CONNECT_DIR=".inoai-connect-planner"` and substitutes that relative value into `ProgramArguments`. It works only because the plist also sets `WorkingDirectory`, but task-0079 explicitly requires an explicit runtime-home path. Set `CONNECT_DIR="$INOAI_ROOT/.inoai-connect-planner"` (or otherwise document an absolute path) and update the placeholder wording.

2. **Low — placeholder count is inaccurate.** `README.md:113` says “replace the five placeholders,” but the template has six (`__LABEL__`, `__NODE_BIN__`, `__INOAI_ROOT__`, `__CONNECT_DIR__`, `__STDOUT_LOG__`, and `__STDERR_LOG__`).

## Checks

- `plutil -lint` passed on a generated disposable plist with absolute executable, project, runtime-home, and log paths.
- `git diff --check` passed.
- The template has no environment variables or credentials; logs are under `~/Library/Logs/inoai` and the existing runtime-home lock is the duplicate-instance safeguard.
- `KeepAlive=true`, `RunAtLoad=true`, and `ThrottleInterval=30` are present.
- `launchctl bootstrap` KeepAlive crash/restart could not be run in this non-GUI execution environment, consistent with the worker handoff; no user LaunchAgent was installed.
- The setup, manual-start boundary, `bootout`, plist removal, duplicate-label guidance, and no-secret guidance are documented.

## Disposition

Returned task-0079 for the focused documentation/path fix. Re-review the generated plist and live-test limitation after the worker updates it.
