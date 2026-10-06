---
agent: worker
role: worker
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# task-0039 worker handoff

Task status: `review`. The full findings are in `docs/phase-5a-claude-cli-spike.md`. No `src/` changes were made. Only that doc and the task Notes changed.

## Findings summary (Claude Code 2.1.287)

- **Event shapes (confirmed).** The stream contains `system/init` (with `session_id`, `apiKeySource`, `permissionMode`, `model`), assistant `text`/`thinking`/`tool_use` blocks, user `tool_result`, `rate_limit_event`, and the final `result` (`subtype`, `is_error`, `result`, `terminal_reason`, `permission_denials`, `errors`). It also contains several undocumented system subtypes, so the adapter must skip unknown events.
- **Session and resume (confirmed).**
  - `--session-id` sets the ID.
  - `--resume` works across processes and keeps the same ID.
  - An unknown resume exits 1 with an `error_during_execution` result, `num_turns:0`, and no init event, so it is pre-start.
  - Reusing `--session-id` exits 1 with "already in use".
- **Append prompt and model (confirmed).** `--append-system-prompt` appends and keeps the default prompt. Both the `haiku` alias and the full model ID work. Caveat: `--system-prompt-snapshot` defaults to `on`, so a changed append on resume is ignored (observed). The adapter task must decide whether to pass `off`.
- **Permission denials (confirmed).** In `-p` mode, prompts are auto-denied. Denials show up as `system/permission_denied` events, `is_error` tool results, and `result.permission_denials`. The Turn still ends `success` with exit 0. `--permission-prompts none` makes the denial explicit. `tool_input` and `message` contain raw command and file content, so they must never be persisted.
- **Credential source (confirmed for the subscription case).**
  - `claude auth status --json` reports `loggedIn`, `authMethod:"claude.ai"`, and `apiProvider:"firstParty"`, with no `apiKeySource` key. It also includes email and org fields, which must be discarded.
  - The init event reports `apiKeySource:"none"`.
  - The value sets for other sources were read from the CLI bundle, not exercised.
- **SIGINT (confirmed, one run).**
  - Exit 0 and a `[Request interrupted by user]` user event.
  - The result is `error_during_execution` with `terminal_reason:"aborted_streaming"`.
  - The Session resumes afterwards.
- **Auth and usage failures.**
  - Not logged in was observed via `--bare`: the assistant event has `error:"authentication_failed"`, and the result has `is_error:true` and `terminal_reason:"api_error"` (subtype `success`), with exit 1.
  - The expired-auth and usage-limit shapes are **unknown**. Candidate signals are listed in the doc.
- **Persistence (confirmed).**
  - Sessions are stored at `~/.claude/projects/<cwd with non-alnum→'->/<session-id>.jsonl`.
  - `--no-session-persistence` wrote no session file.
  - The probe's project folder and temp dir were deleted by literal path after their contents were verified.

## Evidence commands

All runs used a `mktemp -d` cwd.

- `claude --version`, `claude --help`, `claude auth status --help`, `claude auth status --json` (redacted)
- `claude -p --output-format stream-json --verbose --session-id <uuid> --model haiku --append-system-prompt "...ZEBRA-42." "Reply with just the word hello."`
- `claude -p ... --resume <uuid> --model claude-haiku-4-5-20251001 ...` (recall and environment cwd), then again with a different append (snapshot check)
- `--resume <unknown-uuid>`; `--session-id <existing-uuid>`
- `--no-session-persistence` Bash `touch` and Write probe (denied); `--permission-prompts none` Bash `touch` probe (denied)
- A long essay with `--include-partial-messages`, then `kill -INT`, then `--resume`
- `claude --bare -p ... --no-session-persistence` with API key env unset (not logged in)
- `strings`/byte search of the installed binary for the `authMethod`, `apiProvider`, `apiKeySource`, assistant `error`, and rate-limit enums
- `git diff --check` was clean.

## Open questions

- Expired-auth and usage-limit stream shapes need live observation, possibly during task-0048 smoke acceptance.
- SIGINT during a running tool call was not tested.
- Should `--system-prompt-snapshot off` be passed so `agent.md` edits reach existing Sessions? This is a decision for the planner or adapter task.

## Suggested skills

- `codebase-design` for task-0041/0042 (provider seam and adapter).
