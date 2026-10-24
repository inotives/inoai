---
id: BL-0015
title: Fake-CLI timeout tests race under parallel load
type: bug
status: promoted
created_at: 2026-10-23T17:05:00Z
source: IP-0002 T-0007 worker handoff 1
promoted_to: IP-0004
---

# BL-0015: Fake-CLI timeout tests race under parallel load

## Description

Two tests give a real fake-CLI child process a short production timeout. Under load, the timeout fires before the fake CLI records its call, so `fake.calls()` is empty and `call.pid` throws.

- `src/inoai/test/agent-runtime/runtime-review.test.ts:166` (`reviewTimeoutMs: 300`): "Claude review times out, kills the CLI, and cleans up".
- `src/inoai/test/agent-runtime/claude-runtime.test.ts:371` (`idleTimeoutMs: 200`): "an idle Turn times out, kills the CLI, and is not replay-safe".

Also: `transport.test.ts` uses fixed `setTimeout(resolve, 10|20)` sleeps before positive assertions (about lines 291, 371, 406, 411, 449, 577, 725, 891, 896, 972, 977).

## Reproduction

- Steps to reproduce: run three `npm test` suites concurrently, several times.
- Expected: all tests pass.
- Actual: 2 of 9 parallel runs failed with `TypeError: Cannot read properties of undefined (reading 'pid')`.

## Context and evidence

- Source: IP-0002 T-0007 worker handoff 1 (local workflow record).
- Fix ideas: longer test timeouts, or a fake CLI that records its call before the timer can fire.

## Discussion

- [2026-10-24] Recheck on `main` at `16b551c`: still open. The two runtime tests are unchanged (`runtime-review.test.ts:169`, `claude-runtime.test.ts:374`). `transport.test.ts` line numbers moved: fixed sleeps before assertions at :292, :404, :484, :519, :524, :690; 100 × 10 ms lock loops at :560 and :836. The loops at :1002-1011 and :1083-1092 are already deadline-based.

## Open questions

None
- [2026-10-23] IP-0002 T-0007 reviewer: the lock-file polling loops at `transport.test.ts:446` and `:722` have a 1 s budget (100 × 10 ms), short under heavy load. The fixed `setTimeout(resolve, 10|20)` sleeps before exact-count assertions (after lines 288, 371) could become deadline waits plus a short negative flush.
