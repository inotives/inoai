---
id: task-0072
title: "Phase 6c: Optional BigQuery configuration and ADC"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-03
updated_on: 2026-10-03
priority: high
parent: ""
depends_on:
  - task-0071
message: Re-review clean after default-disabled BigQuery fix; sample blank,
  interval-only ignored, configured validation and ADC docs verified. npm test
  197, typecheck, build, diff check pass.
---







# Task

## Goal

Make BigQuery opt-in and configure it without putting credentials in inoai.

## Scope

- Add optional project, dataset, and adjustable sync-interval configuration.
- Use Google Application Default Credentials; never accept or store service-account private keys.
- Missing configuration or ADC must leave normal startup and chat behavior unchanged.
- Add offline validation and safe diagnostics that do not print tokens or credential contents.
- Add step-by-step ADC setup for repository clones to the README.

## Acceptance Criteria

- [ ] BigQuery is disabled by default.
- [ ] Invalid configuration fails only the optional sync path, not the core.
- [ ] ADC setup and verification instructions are documented.
- [ ] Tests prove secrets are not logged or persisted.
