---
agent: planner
role: planner
tool: claude
task: phase-6
task_title: "Phase 6: Daily Memory Review"
status: done
---

# Phase 6 planner handoff

Phase 6 adds the silent Daily Memory Review. Branch `feature/phase-6`.

## Owner decisions

- Recaps are per Agent Session (glossary updated).
- Reviews run text-only in throwaway sessions (ADR 0010). Claude uses `--tools "" --strict-mcp-config --no-session-persistence --permission-prompts none --safe-mode --system-prompt <fixed>` in a fresh temp cwd and fails closed if init reports tools, MCP servers, memory paths, or a non-subscription key source.
- D2: Codex review code exists but is disabled (its review thread still loads the owner's MCP servers); Codex and OpenCode homes skip reviews and keep cursors. Only Claude reviews in V1.
- Deterministic validation; Manual Memory Entries read-only to reviews; deletes need evidence.
- One catch-up cycle per local date; chat preempts reviews without consuming attempts; retries 1/2/4 h.
- D3: the engine passes deterministically detected explicit owner requests to the aggregation step.
- Acceptance: fake-runtime tests plus a live seeded Claude review (no Discord).

## Tasks

0058 spike → 0059 runtime review seam → 0060 engine and validation → 0061 scheduler → 0062 README → 0063 live review (blocked once; fixed by 0065) → 0064 integrated review. All `done` with independent reviews and several fix rounds (0058 ×2, 0059, 0060 ×3, 0061, 0062, 0064 docs).

Notable catches: owner CLAUDE.md leaking into reviews without `--safe-mode`; lost early abort; loose "remember" matching; out-of-order row ranges; multi-line secret leaks; the cycle running inside a chat wake; the live run showing window notes drop explicit requests (D3).

## Verification

- `npm test` 190/190 (main 144), typecheck, build, diff checks clean.
- Live seeded Claude review (haiku, CLI 2.1.288): pnpm request added with provenance; quoted instruction, agent text, fake key, and tool request ignored; no tools, no files, key never in prompts or stored outside the raw archive. Passed 2/2 after task-0065, including an independent reproduction.

## Follow-ups

- F1 Explicit-requests overflow (4000 chars) drops the newest requests and the cursor passes them; end the range before the first request that does not fit.
- F2 Verify with real Codex that MCP and web search can be disabled for review threads before enabling Codex reviews; revisit the strict item allowlist and uninterruptible `turn/start` timeout.
- F3 Fixed-notice exclusion table does not catch older notice wording after text changes.
- F4 Re-verify `--safe-mode` on every Claude CLI upgrade; init cannot show CLAUDE.md loading.
- F5 Window notes dropped explicit requests in 3/3 haiku samples; recurrence-based adds still depend on notes.
- F6 Add a scheduler test for an ended Session's tail after reset.
- F7 Phase 7 UI must handle completed reviews with a NULL recap.
- F8 `memory delete` error text says "Manual Memory Entry not found" though it deletes either kind.
- F9 A preempted Claude review can overlap a new Turn for about 2 s.
