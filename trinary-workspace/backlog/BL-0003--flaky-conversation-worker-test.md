---
id: BL-0003
title: Flaky conversation-worker thread controls test
type: bug
status: open
created_at: 2026-10-23T07:15:05Z
source: T-0002 reviewer handoff
promoted_to: null
---

# BL-0003: Flaky conversation-worker thread controls test

## Description

`conversation-worker.test.js:127` ("thread controls authorize the owner…") timed out once in a full `npm test` run and passed on reruns.

## Reproduction

- Steps to reproduce: run `npm test` repeatedly on `feat/activity-insights`.
- Expected: the test always passes.
- Actual: occasional `until` condition timeout under full-suite load; 5 isolated reruns passed 15/15.

## Context and evidence

- T-0002 reviewer handoff, Checks run.

## Discussion

- [2026-10-23] Captured from T-0002 follow-ups.

## Open questions

- None
- [2026-10-23] A second test in the same file, "validated cross-session overlap keeps Session FIFO and falls back globally after uncertainty", failed once under a full `npm test` run during T-0006 and passed on 5 reruns (T-0006 worker handoff).
- [2026-10-23] During T-0009, one full `npm test` run had 2 unidentified failures; the next two full runs passed (358/0). Capture the failing names on the next occurrence.

## Discussion addendum

- [2026-10-23] IP-0002 T-0003 found the same pattern in `task-controls.test.ts`: its `until` helper used a fixed `setImmediate` turn budget and became flaky under full-suite load (2 of 12 runs). T-0003 made that one helper deadline-based (5 ms polling, 5-second deadline); 14 of 14 runs then passed. Other turn-limited helpers remain, for example `task-run-executor.test.ts:18` (200 turns). A shared deadline-based helper would cover this item too. Source: T-0003 reviewer handoffs 2 and 3.
- [2026-10-23] IP-0002 T-0006 reviewer saw `transport wakes one global FIFO worker; duplicates do not run twice` (`conversation-worker.test.js:67`) fail once in 6 runs with the tick-bounded `until` at `conversation-worker.test.ts:59` (100 iterations). IP-0002 made the helpers in `task-controls.test.ts` and `task-run-executor.test.ts` deadline-based; `conversation-worker.test.ts` remains. Source: T-0006 reviewer handoff 2.
