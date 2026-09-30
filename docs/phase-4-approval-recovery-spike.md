# Phase 4: Codex approval recovery spike

Date: 2026-09-29  
Codex CLI: `0.157.1`  
Scope: local ChatGPT sign-in, no OpenAI API key, disposable project directory

## Question

Can inoai resume or reject the exact pending Codex approval after both inoai and its Codex app-server process restart, using a saved Codex thread ID and approval record?

## Procedure

1. Start `codex app-server --stdio`, initialize it, and verify `account/read` reports `chatgpt` authentication with `OPENAI_API_KEY` and `CODEX_API_KEY` removed from the probe process environment.
2. Start a persistent Codex thread in a disposable directory with `on-request` approval and a read-only sandbox.
3. Ask a turn to create a harmless marker file in that directory. Wait for `item/commandExecution/requestApproval` without responding.
4. Kill app-server with `SIGKILL`, start a new app-server process, and call `thread/resume` with the saved thread ID.
5. Watch for a reissued approval request, then call `thread/read` with turns included. Check whether the marker was created.

## Observed

- The first process emitted a command approval request with matching thread and turn IDs and an item ID.
- The restarted process resumed the same stored thread successfully.
- No approval request was reissued within 12 seconds. `thread/read` reported the prior turn as `interrupted`.
- The marker file did not exist; the unapproved action did not run.

## Implication

With this installed Codex CLI, the SQLite Session and approval rows can recover the *record* of the pending request, but they cannot by themselves restore the live JSON-RPC request or continue that interrupted turn. Treating a saved approval row as authority to replay the turn could repeat earlier side effects. The Phase 4 requirement that the exact pending approval survive a full process restart is not satisfied by `thread/resume` alone.

This is one controlled run against Codex CLI `0.157.1`, not a claim about every version or transport. V1 now declines new approvals immediately (ADR 0003); this recovery rule applies to pending records left by earlier local builds. After a full inoai/app-server restart, mark such a record `failed`, make any old buttons inert, tell the owner to make a fresh request, and do not silently approve or replay the interrupted turn. See [ADR 0001](adr/0001-fail-closed-codex-approval-recovery.md).
