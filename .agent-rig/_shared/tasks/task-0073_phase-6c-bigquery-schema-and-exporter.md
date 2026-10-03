---
id: task-0073
title: "Phase 6c: BigQuery schema and exporter"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0072
message: "Reviewer clean: approved tables, identity keys, redaction, tombstones,
  partition/clustering, optional client boundary, and non-blocking error
  handling verified; 200 tests, typecheck, build, diff check pass."
---





# Task

## Goal

Implement the one-way analytics export for Conversations/Sessions, Messages, Memory, Recaps, and non-secret Events.

## Scope

- Define stable BigQuery tables and types based on the SQLite schema.
- Include `agent_instance_id`, `agent_name`, source IDs, audit timestamps, and tombstone fields.
- Redact text with existing rules; exclude credentials, environment values, approval details, and raw tool input/output.
- Use idempotent source keys `(agent_instance_id, source_id)`.
- Keep project and dataset configurable; partition by time and cluster by `agent_instance_id`.
- Keep the exporter callable independently; do not block Discord or Memory Review work.

## Acceptance Criteria

- [ ] Exported rows can be distinguished across runtime homes.
- [ ] Repeating an export does not duplicate rows.
- [ ] Soft deletes reach BigQuery as tombstones.
- [ ] Secret-like text is redacted and excluded fields remain absent.
- [ ] Fake-client tests cover success and unavailable-cloud behavior.
