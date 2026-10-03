---
id: task-0076
title: "Phase 6c: BigQuery sync documentation"
type: doc
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: medium
parent: ""
depends_on:
  - task-0075
message: "Documentation review clean: ADC, optional/non-blocking behavior,
  schema, identity, redaction, tombstones, retries, cost/retention, and
  production wiring limitation are accurate. npm test (205), typecheck, build,
  and diff check passed."
---





# Task

## Goal

Make the optional BigQuery path reproducible for repository clones and safe to operate.

## Scope

- Document ADC setup step by step without exposing credential contents.
- Document configuration, default cadence, schema, redaction, tombstones, and retry behavior.
- State clearly that SQLite remains authoritative and BigQuery is analytics-only.
- Include multi-runtime identity examples and cloud-cost/retention considerations.
- Ensure docs match the implemented behavior and ADR 0012.

## Acceptance Criteria

- [ ] A clone can configure ADC and optional sync from the README.
- [ ] No docs instruct users to commit or paste service-account keys.
- [ ] Schema and failure semantics are accurate.
