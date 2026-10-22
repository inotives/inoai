---
id: T-0006
feature: IP-0001
title: Run final integrated acceptance review
status: queued
depends_on: [T-0005]
---

# T-0006: Run final integrated acceptance review

Feature plan: [IP-0001](../../README.md)

## Context

All implementation tasks must pass independent task-level review before phase-wide acceptance. The Trinary project-manager requires one final integrated-review task.

## Goal

Independently verify the integrated Task feature against IP-0001 and record evidence for the human acceptance decision.

## Scope

- Review the integrated code and documentation against every IP-0001 acceptance check.
- Run the focused and phase-level checks required by the implementation, including typecheck/build, architecture check, and relevant tests.
- Check schema migration and isolation from real developer runtime-home data.
- Check Task authorization, serial execution, cancellation/recovery, results storage, and Discord upload fallback.
- Record exact commands, observed outcomes, findings, and any remaining limitations in the reviewer handoff.

## Out of scope

- Editing implementation files or changing earlier reviewer verdicts.
- Merging, pushing, committing, or marking the feature accepted on behalf of the human.

## Dependencies

- [T-0005](../T-0005--task-documentation/README.md) — all implementation and documentation work is reviewed and complete.

## Acceptance criteria

- [ ] Every IP-0001 acceptance check has a recorded result and evidence.
- [ ] Focused tests, TypeScript build/typecheck, architecture check, and diff checks pass, or limitations are reported precisely.
- [ ] No task can write into a different runtime home's database or bypass the configured Agent Runtime policy.
- [ ] Reviewer records exactly one `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED` with concrete evidence.
- [ ] If changes are requested, the task remains under review until the implementation tasks resolve them and this integrated review passes.

## Planner Notes

- This is the final reviewer task. The reviewer does not edit implementation files, change task status, or declare human acceptance.
- Feature acceptance still requires the owner's explicit decision after evidence is presented.

## Implementation Plan

1. Read the accepted feature plan, completed task handoffs, and integrated diff.
2. Run the required checks and inspect the source, schema, tests, and docs independently.
3. Record the verdict and evidence in the reviewer handoff.

## Implementation notes

- Do not run a live Discord check without an available isolated test bot/channel; state clearly if that check is not performed.

## Handoffs

Append project-manager, worker, reviewer, and human-response records in [`handoffs/`](handoffs/). Do not overwrite earlier handoffs.
