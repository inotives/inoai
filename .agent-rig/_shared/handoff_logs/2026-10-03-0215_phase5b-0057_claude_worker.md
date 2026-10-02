---
agent: worker
role: worker
tool: claude
task: task-0057
task_title: "Phase 5b: Provider-worded authentication and usage notices"
status: handoff
---

# task-0057 worker handoff

The task is set to `review`. Nothing is staged or committed. I did not read any `.inoai-connect*/.env` and ran no real CLI.

## Change

- `src/conversation-worker.ts`: a new constant `providerNoticeKinds = {authentication, usage, session_missing}`. For those kinds the worker archives `outcome.notice`. Other kinds keep their earlier notices: `uncertain` and `timed_out` get the uncertain notice, and `pre_start`, `cancelled`, and the catch path get the generic notice. The global-FIFO fallback condition is unchanged: only `uncertain`, `timed_out`, and thrown errors trigger it.
- Seam: an optional field `readonly authenticationNotice?: string` on `AgentRuntime` in `src/agent-runtime.ts`. In `src/runtime-turn.ts`, `failureNotice` now returns `authenticationNotice ?? <existing template>`. Only `OpenCodeRuntime` sets the field (`src/opencode-runtime.ts`). Codex and Claude do not set it, so their text is the unchanged HEAD template. Compared with `git show HEAD:src/runtime-turn.ts`, the only changed `case` line is the authentication line, where the `??` prefix was added. The pinned `runtime-turn` notice tests pass unchanged.
- Notices are fixed literals. None includes runtime output, error text, or secrets.

## Final notice texts

| Provider | authentication | usage |
|---|---|---|
| Codex | Codex sign-in needs attention. Run codex login locally, then send a fresh request. | Codex usage is unavailable. Check your account locally, then send a fresh request. |
| Claude | Claude sign-in needs attention. Run claude /login locally, then send a fresh request. | Claude usage is unavailable. Check your account locally, then send a fresh request. |
| OpenCode | OpenCode could not authenticate with its configured provider, or the free tier refused the request. Check opencode auth login locally, then send a fresh request. | OpenCode usage is unavailable. Check your account locally, then send a fresh request. |

## Tests

- `src/test/conversation-worker.test.ts`: a helper `failedTurnNotice` runs one failing Turn through `ConversationWorker` with a `FakeTransport`. Its fake runtime borrows the identity fields (`displayName`, `loginHint`, `authenticationNotice`) from the real adapter instances. The constructors are side-effect free, so no CLI is spawned.
  - Test 1: every provider × {authentication, usage}. It asserts the exact Discord text, attempts 1, `Runtime <kind>; replay_safe=false`, Message `failed`, and that the mode stays `per-session`, meaning no fallback.
  - Test 2: `uncertain` gets the uncertain notice and the mode falls back to `global`. `cancelled` gets the generic notice and the mode stays `per-session`.
- `src/test/runtime-turn.test.ts`: the override applies to `authentication` only. `usage` keeps the template.

## Docs

- `docs/implementation-phases.md`: the Phase 5b scenario now says that rate-limit and authentication results map to fixed OpenCode-worded notices, and that the authentication notice also covers a free-tier refusal.
- README needed no change. It already says a Claude per-Turn credential refusal tells you to run `claude /login`, and that statement is now true. The OpenCode README is task-0054.

## Checks

- `npm test`: 144/144 pass. The baseline was 142.
- `npm run typecheck` and `npm run build` are clean.
- `git diff --check` is clean.

## Review focus

- Confirm that the FIFO fallback set is unchanged.
- Confirm that the optional-field seam is the narrowest acceptable seam.
