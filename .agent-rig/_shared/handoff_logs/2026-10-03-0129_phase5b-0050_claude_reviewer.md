---
agent: reviewer
role: reviewer
tool: claude
task: task-0050
task_title: "Phase 5b: OpenCode headless contract spike"
status: handoff
---

# Review: task-0050 OpenCode headless contract spike

## Verdict

The research holds up. Every scope bullet is answered or marked unknown, the version (`v2.0.22`) is recorded, redaction is clean, the stop rule correctly did not fire, and both spot-checked claims reproduced. However, the doc has wording problems that a downstream worker on task-0052 or task-0053 could misread. Two are medium severity. Fix them in `docs/phase-5b-opencode-cli-spike.md` before marking the task `done`. The persona finding needs a planner decision either way.

## Findings

1. **Medium: the `pre_start` rule contradicts itself** (`docs/phase-5b-opencode-cli-spike.md:143` vs `:150`). The table row says an exit or error "with no `step_start` and no session created (the existence check confirms which)" is replay-safe `pre_start`. The caveat says "replay only when no event at all was emitted and the process failed to start". These rules disagree, and the table row cannot be applied:
   - On a first Turn with no `sessionID` event, there is no ID to check.
   - On a resumed Turn the session always exists.
   - The free-tier sample shows OpenCode persists the user message before the provider `error`. A replay would therefore append a duplicate user message to the session.

   Fix: drop the "existence check confirms which" clause. State one rule: `pre_start` (replay-safe) only for a spawn failure (ENOENT/EACCES), or a non-zero exit with zero parsed stdout events. Any event carrying a `sessionID` means the Turn started (not replay-safe), even before `step_start`. This matches the Claude precedent: only a no-init result is `pre_start`. Also say what a non-`SessionNotFoundError` exit 1 from the existence check maps to (suggest `pre_start`, since no Turn ran), so task-0052 does not treat every exit 1 as `session_missing`.

2. **Medium: the denial guidance conflicts with task-0053 about tool names** (`:91`). It says "record only a count and tool names". Task-0053 says "without retaining tool names, resources, or input", and the Event is `denials=<n>` only. Line 151 is count-only. Fix: change line 91 to count only.

3. **Low/medium: the authoritative denial count source is ambiguous** (`:91`, `:151`). The doc calls stdout primary and stderr a "second check" but never says what happens when they disagree. It also never says whether the `/usr/share` external_directory rejection produced its own stdout `tool_use` error event; the only sample shown is the `read` event. A worker could sum both sources and double-count. Fix: state that the count is the number of stdout `tool_use` events with `state.status:"error"` and the fixed-text prefix. Stderr lines are not added; at most use them for a debug-level mismatch, never stored. Also record whether stdout and stderr counts matched in the probe (2 and 2?). If one tool call can raise several permission requests, the stdout count is per tool call. Either way, the notice is once per Turn.

4. **Low: the persona doc does not name the plan docs that must change** (`:60-78`, `:132-136`). The worker handoff lists them, but the spike doc only says "the planned mechanism does not work". A task-0052 worker reading the task scope ("via `OPENCODE_CONFIG_CONTENT` ... (or the fallback the spike selected)") will find that the spike selected nothing. Fix: add a "Planner decision required" note naming:
   - `docs/implementation-phases.md:201` (task 3 persona wording)
   - `docs/discord-codex-cli-harness-proposal.md:104` ("`agent.md` is added through OpenCode's `instructions` config")
   - the task-0052 Persona scope bullet
   - the Phase 5b test scenario at `docs/implementation-phases.md:214`

   Option (a) also costs one extra ~0.3 s `opencode api` process per Turn, on top of the ~0.3 s existence check. It adds a synthetic "The instructions changed" message to the session on each edit. Both are worth stating.

   The evidence is adequate but thin: one run (`ok PANDA-9`, reasoning cites only AGENTS.md) plus binary-string analysis. The doc labels the binary claims. A second negative run, for example with only `OPENCODE_CONFIG_CONTENT` and no AGENTS.md, would rule out AGENTS.md crowding out the other instructions. Optional.

5. **Low: the free-tier `FreeTierError` explanation and general risk** (`:46-50`, `:141`). The explanation is adequate: it is reproduced twice, a control run succeeded, and the cause is marked inferred. One unproven hypothesis is that OpenCode `ses_` IDs are time-ordered (timestamp-prefixed), so a random ID may fail a gateway sanity check. The doc should state the wider risk explicitly. The Zen free tier is gated on "from within OpenCode", and inoai-driven runs currently pass only because they are the stock CLI with OpenCode-generated IDs. A future gateway or CLI change could reject headless or inoai-driven runs. That would surface as `provider.auth`, mapped to `authentication`, with the login hint `opencode auth login`, which would mislead a free-tier user. Suggest a short README/task-0054 note, and consider wording the `authentication` notice so it also covers free-tier refusal.

6. **Low: how to build the answer is unclear** (`:130`). "Concatenate the `part.text` of `text` events" would include interim narration from tool-call steps (text emitted before a `step_finish reason:"tool-calls"`). The Claude adapter answers from the final `result` only. Fix: say whether to join all text blocks (and with what separator) or only the blocks after the last tool step, and pick the option closest to Claude's behavior.

Nothing in the doc is wrong about stdin prompts, SIGINT (exit 130, `unknown` transport error, cancel classified from exit code plus cancel-requested, session resumes), or the existence-check command itself.

## Checks

- Redaction: I grepped the spike doc, the worker handoff, and the task file for full `ses_`/`msg_`/`prt_` IDs, `/Users/`, the username, `/var/folders`, emails, `sk-`, `Bearer`, and api keys. There were no hits; the only matches were token counts and the `ZEBRA-42` marker text.
- `git diff --check` is clean, and `git diff --no-index --check /dev/null docs/phase-5b-opencode-cli-spike.md` reports no whitespace errors. `git diff --stat -- src/` is empty: no `src/` changes.

## Spot checks (opencode v2.0.22, fresh `mktemp -d` cwd, absolute binary, `--format json --standalone`, prompt on stdin, default model)

- (a) Existence check:
  - `opencode api --standalone GET /api/session/<bogus ses_ id>` exits 1 with stdout `SessionNotFoundError` and stderr `HTTP 404 Not Found`. `session list` stayed empty, and a re-GET still exited 1, so nothing was created.
  - After a real run, GET on the streamed `sessionID` exited 0 with `outcome:"succeeded"`.
  - Confirmed.
- (b) Resume: a second run with `--session <id>` exited 0. Every event carried the same `sessionID`, the model recalled "ok", and `session list` showed one session. Confirmed.
- First-run shape: `step_start`, then `text` "ok", with no `step_finish` and empty stderr. This matches the doc.
- Prompts sent (2 of 3 allowed): "Reply with the word ok"; "What exact word did I ask you to reply with in my previous message? Answer with just that word."
- Cleanup: deleted the one session with `opencode session delete --standalone` ("Session <id> deleted"). GET then exited 1, `session list` was empty, the temp dir was removed and verified gone, and no stray `opencode run` processes were left. No OpenCode config, DB, credentials, service, or `.inoai-connect*` were touched, and no permission-loosening flag or `--model` was used.

## Next

Send this back to the worker for doc-only fixes 1–3 (4–6 are recommended). Re-review, then the planner decides the persona mechanism before task-0052. I did not change the task status.

## Suggested skills

- `grilling` (planner: persona mechanism decision)
- `code-review` (re-review)
