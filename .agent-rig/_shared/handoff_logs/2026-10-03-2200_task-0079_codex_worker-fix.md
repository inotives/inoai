---
agent: worker
role: worker
tool: codex
task: task-0079
task_title: macOS launchd supervisor fallback
status: review
---

## Summary

- Fixed the launchd README installer to substitute an explicit absolute runtime-home path (`$INOAI_ROOT/.inoai-connect-planner`) into `ProgramArguments`.
- Corrected the placeholder count from five to six.
- Preserved the optional/manual-start boundary, runtime lock duplicate safeguard, no-secret plist guidance, and the limitation that live `launchctl` testing requires a GUI session.

## Verification

- `plutil -lint launchd/com.inotives.inoai.plist.template` — passed.
- Generated disposable plist with absolute Node, project, runtime-home, and log paths; `plutil -lint` — passed.
- Extracted `ProgramArguments`; runtime home is `/Users/inotives/workspaces/ino-ai/.inoai-connect-planner` — passed.
- `git diff --check` — passed.

No commit or push performed.
