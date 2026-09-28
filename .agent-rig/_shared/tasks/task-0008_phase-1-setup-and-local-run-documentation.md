---
id: task-0008
title: "Phase 1: Setup and local-run documentation"
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-09-27
updated_on: 2026-09-28
priority: high
parent: ""
depends_on:
  - task-0003
  - task-0005
  - task-0006
message: Accepted by the human after review
---










# Task

## Context
Phase 1 must be usable from a clean checkout without external-service contact.

## Goal
Document setup, configuration, validation, runtime-home behavior, and local UI invocation.

## Scope
- Update the README with install, build, test, bootstrap, configuration validation, and `inoai ui` instructions.
- Explain that `.inoai-connect*/` is local state and must not be committed.
- Do not document unsupported remote, scheduler, or non-Codex features.

## Planner Notes


## Implementation Plan


## Acceptance Criteria

- [ ] A new developer can follow the README to install, configure, and validate locally without contacting Discord or Codex.
- [ ] The documented commands match implemented scripts and runtime-home behavior.

## Notes

## Blockers

- 2026-09-27: Awaiting task-0003, task-0005, and task-0006.
