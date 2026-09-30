---
agent: reviewer
role: reviewer
tool: codex
task: task-0028
task_title: "Phase 4: Runtime failures and safe retry"
status: blocked
---

# Task 0028 independent review

## Finding

- `src/codex-runtime.ts:69-72` — After `turn/start` succeeds, `runTurn` waits indefinitely for another notification if the connected app-server never sends `turn/completed`. `CodexAppServer.request` times out the `turn/start` RPC only; it does not bound the subsequent stream. Thus `runRuntimeTurn` cannot record `timed_out`, return its single failure outcome, or let the owner receive the promised failure notice for this post-start timeout. Add a bounded turn/idle timeout at the runtime stream boundary, classify it as uncertain and non-replayable, and test a silent post-start hang. Preserve the active-session lock until the turn is known terminal or the server is stopped, so a timeout does not permit overlapping turns.

The three-attempt cap, explicit pre-start safety proof, structured authentication/usage classifications, non-secret Events, and no-answer-on-uncertain-failure behavior otherwise match task 0028. No Phase 5 queue/delivery work was added.

Verification: `npm test` (63 passed), `npm run typecheck`, `npm run build`, and `git diff --check` passed. The passing tests do not exercise a post-start stream that remains open without a terminal event. No live Discord credentials were supplied; no live test was attempted.

No implementation edits, task status transition, commit, or push by reviewer.
