---
agent: worker
role: worker
tool: claude
task: task-0041
task_title: "Phase 5a: Minimal provider seam"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0041 worker handoff

Read: task file, `docs/implementation-phases.md` Phase 5a task 3, ADR 0001, task-0040 handoffs.

## Seam shape

I added two readonly fields to `AgentRuntime` (`src/agent-runtime.ts`): `displayName` and `loginHint`. `CodexRuntime` sets them to `"Codex"` and `"codex login"`.

I put them on the runtime rather than in a separate descriptor because every consumer already holds the runtime: `runRuntimeTurn`, `ConversationWorker`, and `run()`. A descriptor would mean new parameters for no gain. Supplied runtimes (`suppliedRuntime`, test fakes) now declare the two fields, and the compiler enforces it.

## Changes

- `src/runtime-turn.ts`: the `notices` record is replaced by `failureNotice(kind, runtime)`, which builds the same six sentences from `displayName`/`loginHint`. The `"Codex request timed out:"` match in `failureKind` stays as it is. It matches the error text `CodexAppServer` emits, which is an adapter detail and not a user notice.
- `src/conversation-worker.ts`: the `fallbackToGlobal` warning uses `this.runtime.displayName`.
- `src/index.ts` `run()`: one `switch (instance.configuration.agentProvider)`.
  - `codex` builds `CodexAppServer`, `CodexRuntime`, `ApprovalRelay`, and sets `probeConcurrency = probeCodexConcurrency`.
  - `claude` throws "Claude runtime is not implemented yet" inside the existing try/catch, so `instance.release()` runs.
  - `probeConcurrency` defaults to `async () => false`. A supplied runtime therefore keeps global FIFO, the same as the old `suppliedRuntime ? false : ...`.
  - The startup concurrency log uses `runtime.displayName`.
  - The approval decline logic stays in `ApprovalRelay` and the probe logic stays in `concurrency-probe.ts`. There is no registry.

## Deliberately unchanged: the legacy-approval restart notice

These two strings are still Codex-worded:

- `index.ts` "A saved Codex approval could not be resumed after restart..."
- `transport.ts:182`, the button edit for the same row.

Rows in `approvals` were only ever created by the pre-decline-only Codex approval flow. Claude never creates them (ADR 0007). Any legacy row in any home, including one switched to `claude`, is therefore a Codex approval. Using the running provider's name would make the notice factually wrong in a switched home and inconsistent with the `transport.ts` edit. The other restart-recovery notice, the worker's `uncertainNotice`, was already provider-neutral.

**Planner/reviewer decision:** if you want this notice to follow the runtime anyway, it needs the display name threaded into `startTransport` (a new parameter) and probably also the `transport.ts` edit text.

## Tests

- Mechanical: each fake `AgentRuntime` in `conversation-worker`, `prompt-context`, `response-delivery`, `runtime-turn`, and `transport` tests gained `displayName: "Codex", loginHint: "codex login"`. No assertions changed.
- New, `runtime-turn.test.ts`: asserts the exact Codex text for all six failure kinds, and that a fake runtime named `Claude` with hint `claude /login` yields Claude wording.
- New, `conversation-worker.test.ts`: the concurrency fallback warning names the runtime (`Claude`).
- New, `transport.test.ts`: a temp home with `AGENT_PROVIDER=claude` makes `run([])` reject with "Claude runtime is not implemented yet". Discord `login` is never called, the lock file is gone, and `start()` succeeds again.

## Checks

- `npm test`: 92 tests, 92 pass, 0 fail (was 89)
- `npm run typecheck`: clean
- `npm run build`: clean
- `git diff --check`: clean
- I read no `.inoai-connect*/.env`. Tests use mkdtemp homes only.

## Next

Review task-0041. Task-0042 replaces the `claude` branch with the Claude runtime (`displayName`/`loginHint`), its permission-denial handling, and its probe.
