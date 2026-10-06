---
agent: reviewer
role: reviewer
tool: codex
task: task-0031
task_title: "Phase 5: Durable turn and delivery state"
status: done
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Task 0031 re-review

No findings. The previous reset-race finding is resolved: `archiveMessage` atomically records a late user Message against an ended Session as failed, preserving its body, audit fields, and external-ID deduplication; `claimNextMessage` independently excludes non-active Sessions. A separate two-connection disposable-home check confirmed the late row remains failed, duplicate archival returns the same row, and neither connection can claim it.

Reviewed the full task scope again. The durable runtime-start boundary distinguishes pre-start requeue from post-start uncertain failure; response chunks are archived before send with provisional IDs, and only pending chunks are selectable for delivery. Claimed chunks remain uncertain after restart unless confirmed or known-failed. Reset atomically fails queued/processing Messages and unsent chunks while retaining the ended Session and archive. The migration test preserves legacy Message IDs, reply and approval references, and passes `PRAGMA foreign_key_check`.

Verification: `npm test` (69 passed, 0 failed), `npm run typecheck`, `npm run build`, `git diff --check`, and the two-connection reset-boundary check passed. No implementation edits, task-state change, commit, or push. Planner may mark task 0031 done and select its dependent task.
