---
id: BL-0057
title: foreground.test.js fails and hangs under machine load
type: bug
status: open
created_at: 2026-11-13T15:53:00Z
source: IP-0008 T-0011 worker and reviewer handoffs
promoted_to: null
---

# BL-0057: foreground.test.js fails and hangs under machine load

## Description

`src/test/foreground.test.ts` waits a fixed ~2 seconds for the lock file (`waitForFile`, lines 31-35). Under a high load average (about 7–13), "foreground starts a separate UI…" and the "Ctrl+C during slow codex/claude/opencode startup…" tests fail at that wait. The test then leaves child processes running, and the whole `npm test` run hangs until it is killed. The file passes 8/8 when run alone. Use a longer or adaptive wait, and clean up child processes in a `finally` block.

## Reproduction

- Steps to reproduce: run the full `npm test` while the machine load average is about 7 or higher.
- Expected: the foreground tests pass, or fail without hanging.
- Actual: 2–4 foreground tests fail with `File was not created: …/inoai.lock`, and the run hangs. Orphaned `node dist/index.js ui --connect-dir direct:/var/folders/.../inoai-slow-start-*/agent` processes remain.

## Context and evidence

- [T-0011 worker handoff](../features/IP-0008--equippable-roles/tasks/T-0011--fence-aware-roles-and-catalog-recovery/handoffs/20261113_153359--worker-handoff-1.md): the same failure reproduced on a `git archive` of HEAD `8e4bcf9`.
- [T-0011 reviewer handoff](../features/IP-0008--equippable-roles/tasks/T-0011--fence-aware-roles-and-catalog-recovery/handoffs/20261113_155130--reviewer-handoff-1.md): the file passes alone; the rest of the suite passes. The bigger role catalog adds a little bootstrap I/O inside the same 2-second window.

## Discussion

- None yet.

## Open questions

- None
