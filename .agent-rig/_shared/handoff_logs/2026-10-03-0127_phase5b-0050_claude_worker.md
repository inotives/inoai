---
agent: worker
role: worker
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: handoff
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---

# Handoff: task-0050 OpenCode headless contract spike

## Result

Findings are in `docs/phase-5b-opencode-cli-spike.md` (opencode v2.0.22). The task is in `review`. There are no `src/` changes, nothing is staged, and nothing is committed.

## Key findings

- **Sessions:** resume across separate `--standalone` processes works, including after SIGINT. A pre-assigned `--session ses_<random>` creates the session but fails on the free tier: exit 1 with an `error` of `provider.auth`, 403 `FreeTierError` "free tier can only be used from within OpenCode". The adapter must omit `--session` on the first Turn and store the streamed `sessionID`. `--session <unknown>` silently creates an empty session.
- **Existence check:** `opencode api --standalone GET /api/session/<id>` exits 0 when the session exists, and exits 1 with `SessionNotFoundError` and stderr `HTTP 404` when it does not. It creates nothing, it works from any cwd, and it takes about 0.2–0.3 s.
- **Persona (needs a planner/owner decision):** `OPENCODE_CONFIG_CONTENT` `instructions` and project `opencode.json` `instructions` are not applied in 2.0.22. The binary shows that only AGENTS.md files are read as instruction sources. A working additive alternative is the experimental `PUT /api/experimental/session/<id>/instructions/entries/<key>` with `{"value": …}`. It was injected as `<context key=…>` on the next run, alongside AGENTS.md, and AGENTS.md edits also applied on the next run. Its limit is that it needs an existing session, so the first Turn needs the delimited-prompt fallback. The other option is to use the fallback on every Turn. The `docs/implementation-phases.md` Phase 5b task 3 wording and the proposal's "OpenCode runtime" paragraph assume `OPENCODE_CONFIG_CONTENT` and need updating once the planner chooses.
- **Prompt delivery:** an argv prompt is stored wrapped in literal quotes; stdin is stored verbatim. Use stdin.
- **Denials:** a `tool_use` event with `state.status:"error"` and the fixed text "This non-interactive run cannot ask the user for permission, so the request was rejected…", plus a stderr line `! permission requested: <perm> (<resource>); auto-rejecting` (ANSI-colored). The Turn exits 0.
- **End of Turn:** there is no reliable terminal event. The final text step has no `step_finish`, so process exit marks the end. `GET /api/session/<id>` returns `outcome`.
- **Exit codes:** 0 success; 1 error event; 130 SIGINT, with an `error` of `type:"unknown"` "Transport: socket closed".
- **Latency:** standalone startup to prompt acceptance is about 290–306 ms (5 samples), against about 106 ms via the service. The stop rule does not apply.
- **Rate limit:** not observed. The binary enum includes `provider.rate-limit` and `provider.quota`.

## Evidence and cleanup

- 11 model runs with trivial prompts (10 standalone, 1 through the service).
- 8 sessions created, all deleted with `opencode session delete --standalone` and verified with `GET` (exit 1) and empty `session list`. 7 temp directories removed. Per-directory OpenCode project records may remain; there is no CLI delete for them, and the database was not touched.
- No OpenCode config, `service.json`, database, credentials, or `.inoai-connect*` were read or modified.
- Checks: `git diff --check` was clean, and `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md` reported no whitespace errors.

## Suggested skills

- `grilling` (planner: decide the persona mechanism with the owner, and possibly record an ADR amendment)
- `code-review` (reviewer)
