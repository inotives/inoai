---
agent: reviewer
role: reviewer
tool: claude
task: task-0058
task_title: "Phase 6: Claude text-only review spike"
status: done
---

# task-0058 re-review (reviewer handoff)

Verdict: **clean, approve.** All three prior findings are resolved. The spike doc, ADR 0010, Phase 6 task 2 and task-0059 agree. Two non-blocking notes on downstream planner task files are below; neither is in task-0058's scope. Doc-only review. No CLI runs, no edits except this handoff, task status left for the manager, nothing committed.

Inputs: the reviewer role, task-0058, the prior review `2026-10-03-0827_phase6-0058_claude_reviewer.md`, the fix handoff `2026-10-03-0829_phase6-0058-fix_claude_worker.md`, `docs/phase-6-claude-review-spike.md`, ADR 0010, `docs/implementation-phases.md` Phase 6 task 2 (:231), task-0059, task-0060 and task-0063.

## Prior findings

1. **Medium (owner context leakage): resolved.**
   - `spike:46-47` covers the auto-memory instructions in the default prompt, user CLAUDE.md loading as user context, and Recap persistence.
   - Finding 6 (`spike:111-129`) records spot-checks A and B, the `--safe-mode` help text, the caveats and the owner decisions.
   - The 0059 implication (`spike:152`) gives the final flag set and the fail-closed `memory_paths`/MCP/tools backstop.
   - The open question (`spike:157`) is rewritten.
2. **Low (regex claim): resolved.** `spike:144-146` says the regex and `JSON.parse` together enforce exactly one object, that the parse step must stay, that the pattern must not be made non-greedy, and lists the deliberate rejections. task-0060:32 points to "the spike's extraction rule", so this wording carries through.
3. **Low (optional project folder): resolved.** `spike:109` says none is created with `--system-prompt`, and that cleanup must tolerate the missing folder via `src/concurrency-probe.ts:219-236`. `spike:152` and task-0059:31 repeat this.

## Consistency check

| Item | Spike doc | ADR 0010 | Phase 6 task 2 | task-0059 |
| --- | --- | --- | --- | --- |
| Restricting flags (`--tools ""`, `--strict-mcp-config`, `--no-session-persistence`, `--permission-prompts none`) | :152 | "all tools disabled, no MCP servers, no session persistence" | "restricting flags from the spike" | "the spike's restricting flags" |
| `--safe-mode` + `--system-prompt <fixed>`, no `--append-system-prompt` | :129, :152 | yes | yes | yes |
| Fail closed on `memory_paths` / MCP / tools | :129, :152 (plus `apiKeySource`, `tool_use`, `permission_denied` events, `permission_denials`) | yes | yes | yes (`apiKeySource` "as for Turns") |
| Cleanup tolerates a missing folder | :109, :152 | n/a | n/a | yes |
| Regex + `JSON.parse` | :144 | n/a | n/a | n/a (task-0060:32 refers to it) |

There are no contradictions. The Procedure block (`spike:16-18`) still shows the worker's original flags. That is correct as history, and finding 6 and :152 supersede it.

## Non-blocking notes (planner, downstream tasks)

- **Info: task-0059:31.** The backstop names only `memory_paths`, MCP servers, tools and `apiKeySource`. The spike's list (`spike:152`) also fails on any `tool_use` block, any `permission_denied` event, and non-empty `permission_denials`. task-0059 says to follow the spike, so a worker should pick these up, but naming them explicitly would avoid a gap. Optional.
- **Low: task-0063:34.** "Clean up ... `~/.claude/projects/<encoded>` folder (verify contents first)" does not say that the folder is normally absent under `--system-prompt`/`--safe-mode`. A worker could treat absence as an anomaly. Fix: add "when present; absence is expected".

## CLAUDE.md-detection recommendation

The doc's statement (`spike:157`) is accurate: init has no CLAUDE.md field, so the init backstop cannot detect CLAUDE.md loading. **This is acceptable as documented.** A live canary is not recommended:

- **It would need owner data.** The user-level CLAUDE.md is the risk. A canary needs a known marker phrase there, and that means either editing `~/.claude` (forbidden) or relying on private text from the owner's own CLAUDE.md inside a committed test or handoff. The prompt itself would then carry owner content.
- **A project-level canary proves nothing.** The review cwd is a fresh empty temp dir, so a canary CLAUDE.md placed there tests nothing relevant.
- **The signal is weak.** It is the model's own report, and that is non-deterministic.

Cheaper and deterministic instead:

- **task-0059:** fake-CLI tests assert that the argv contains `--safe-mode` and `--system-prompt`, and never `--append-system-prompt`, `--resume` or `--session-id`. A regression test then fails if someone drops the flag.
- **task-0063:** record the captured init evidence in the handoff (`tools: []`, `mcp_servers: []`, `memory_paths` absent, `apiKeySource: "none"`) and the CLI version. The proven link between `--safe-mode` and the missing `memory_paths` is the best objective proxy for "safe mode took effect".
- **On a CLI version change:** keep the open question that `--safe-mode` drift needs re-verification, which the doc already records. Optionally, a manual owner-run spot-check like A/B, kept out of committed artifacts.

The downstream controls stay in place regardless: 0060's Recap and secret validation, and the length caps.

## Checks

- **Whitespace:** `git diff --check` is clean. `git diff --no-index --check /dev/null docs/phase-6-claude-review-spike.md` reports no whitespace errors (exit 1 only because the file differs from /dev/null).
- **Redaction grep:** I searched the spike doc, ADR 0010 and the fix handoff for `/Users/`, the username, `var/folders`, the org domain, `sk-` keys, emails, session UUIDs, and the CLAUDE.md marker words. The only hits were `task-00xx` false positives on the `sk-` pattern.
- **Source:** there are no `src/` changes.

## Next

The manager may mark task-0058 `done` and unblock task-0059. The planner can optionally apply the two downstream notes.
