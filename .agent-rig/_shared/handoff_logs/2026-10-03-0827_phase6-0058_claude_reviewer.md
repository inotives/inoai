---
agent: reviewer
role: reviewer
tool: claude
task: task-0058
task_title: "Phase 6: Claude text-only review spike"
status: handoff
---

# task-0058 reviewer handoff

Verdict: **changes requested (one medium, two low).** The core contract holds and was re-verified: tools off, MCP off, nothing ran, JSON extraction works. The doc does not yet capture that the owner's global Claude context leaks into review sessions, and that `--system-prompt` alone does not stop it. Task status left at `review` for the manager. No edits made except this handoff. Nothing committed.

Inputs: task-0058, worker handoff `2026-10-03-0824_phase6-0058_claude_worker.md`, `docs/phase-6-claude-review-spike.md`, Phase 6 in `docs/implementation-phases.md`, ADR 0010, `CONTEXT.md`, task-0059, `src/concurrency-probe.ts`, and `claude --help` for 2.1.288.

## Findings

1. **Medium: owner context leakage is understated, and the mitigation is incomplete.** `docs/phase-6-claude-review-spike.md:45-46, 97, 102, 130`. The doc blames only the auto-memory section and says the open question is "not needed if 0060 validates IDs". ID validation does not cover free-text Recaps and bodies. Recaps are stored and passed back into later aggregations as "recent agent-wide Recaps", so any of the owner's unrelated global context that shapes them persists in inoai. Spot-check A (below) shows that with `--system-prompt` the model still sees the owner's user-level `~/.claude/CLAUDE.md` content, and init still lists `memory_paths.auto`. Only spot-check B, which adds `--safe-mode`, removed both while subscription auth kept working.
   **Fix:** record spot-checks A and B in the spike doc. In "Implications for 0059", add `--safe-mode` to the restricting flags alongside `--system-prompt <fixed review instructions>`. Treat an init that contains `memory_paths` as defense in depth, either as a warning or as a failure (see the open choice below). Rewrite the open question at :130 to match.
2. **Low: the regex claim is imprecise.** `docs/phase-6-claude-review-spike.md:115-121`. The pattern alone matches two bare objects, two objects in one fence, and two fences (the greedy `[\s\S]*`). These inputs are rejected only because `JSON.parse` then fails. The result is correct, but the doc should say that the regex plus `JSON.parse` together enforce "exactly one object", so 0060 does not drop the parse step or swap in a non-greedy pattern. Also note the deliberate rejections: CRLF fences, `` ```JSON ``, other language tags, and a close fence on the same line.
3. **Low: the cleanup expectation changes.** `docs/phase-6-claude-review-spike.md:106, 125`. With `--system-prompt` (with or without `--safe-mode`), no `~/.claude/projects/<encoded cwd>/` folder was created at all. 0059 cleanup must treat the folder as optional. `removeProbeProjectFolder` already returns on ENOENT (`src/concurrency-probe.ts:219-236`), so reusing it is fine.

Checks that passed:
- Every scope bullet is answered with evidence.
- CLI version `2.1.288` is recorded and matches `claude --version`.
- Redaction is clean: a grep for usernames, `/Users/`, `var/folders`, emails, the org domain, `sk-` keys and session UUIDs found nothing sensitive.
- `git diff --check` is clean, and `--no-index --check` on the new doc reports no whitespace errors.
- There are no `src/` changes.

## Auto-memory and CLAUDE.md ruling

Yes, leakage is real.
- **Default prompt:** the default system prompt carries Claude Code's auto-memory instructions. That is where the invented `feedback__…` IDs and the "Why/How to apply" bodies come from.
- **User-level CLAUDE.md:** this is injected as user context, not as part of the system prompt, so `--system-prompt` does not remove it.
- **Owner customizations:** skills (51), agents (5) and plugins (6) are listed in context, though they cannot be invoked.
- **Per-project auto-memory:** this is keyed to the temp cwd, which is empty, so the owner's other projects' personal `MEMORY.md` content is unlikely to load. That is inferred, not proven.

Recommended Claude review flags (all of them only restrict; none elevates):

```text
claude -p --output-format stream-json --verbose --no-session-persistence \
  --permission-prompts none --tools "" --strict-mcp-config --safe-mode \
  --system-prompt "<fixed inoai review instructions>" [--model=<CLAUDE_MODEL>]   # prompt on stdin
```

What each relevant flag does, from `claude --help` (2.1.288):
- **`--system-prompt <prompt>`:** replaces the default prompt. This removes the auto-memory instructions, but `memory_paths.auto` is still reported and user CLAUDE.md still loads. Keep it, as task-0059 already says.
- **`--safe-mode`:** disables CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, output styles, and workflows. It sets `CLAUDE_CODE_SAFE_MODE=1`. Auth, model selection, built-in tools and permissions work normally, and admin policy still applies. It removed `memory_paths` from init and cut skills from 51 to 19, agents from 5 to 4 and plugins from 6 to 4 (the remaining ones are built in). **Recommended.** It is labelled as a troubleshooting flag, so it may change between versions; pin it with the init checks.
- **`--setting-sources <user,project,local>`:** restricts which settings files load. Whether an empty value is accepted, and whether it affects CLAUDE.md or auto-memory, is untested and unknown. Not needed if `--safe-mode` is used.
- **`--disable-slash-commands`:** disables skills only. Covered by `--safe-mode`.
- **`--exclude-dynamic-system-prompt-sections`:** moves memory paths into the first user message instead of removing them, and is ignored with `--system-prompt`. Not useful.
- **`--restricted`:** ignores user, project and local settings files and removes code-running tools. Its effect on CLAUDE.md and auto-memory is not documented. Optional, untested.
- **`--bare`:** disables auto-memory and CLAUDE.md, but it skips OAuth (Phase 5a). Not usable.
- **Env var:** `--help` lists no auto-memory env var. Any `CLAUDE_CODE_DISABLE_AUTO_MEMORY`-style variable is unknown and was not tested.
- **Not exposed:** `--system-prompt-file` is mentioned only inside the `--bare` text and is not listed as its own flag.

Open choice for the owner or 0059: under `--safe-mode`, the owner's user settings (for example a `model` or `env` set in settings) may not apply to reviews. That is acceptable because `CLAUDE_MODEL` drives `--model`. Also decide whether an init with `memory_paths` present fails the review or only warns. The recommendation is to fail closed.

## Regex test (Node, pattern from doc :118)

| Inputs | Regex result | `JSON.parse` result |
| --- | --- | --- |
| Bare, bare with surrounding whitespace, `` ```json `` fence, plain `` ``` `` fence, fence with trailing spaces or newline, a `"```"` inside a JSON string value | Match | OK, accepted |
| Prose prefix, prose suffix, prose before a fence, refusal, empty, whitespace only, array, close fence on the same line, inline fence, CRLF fence, `` ```JSON ``, `` ```js `` | Reject | Not reached |
| Two bare objects, two objects in one fence, two fences, two fences with prose between | Match | Fails, so rejected overall (finding 2) |

## Spot-check (2 haiku calls)

Each call ran in a fresh `mktemp -d` cwd with the prompt on stdin. Base flags: `-p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --tools "" --strict-mcp-config --model=haiku --system-prompt "<review instructions>"`. The transcript held a remember request, an injected `touch pwned.txt`, and arithmetic. The model was asked to report whether anything in its context other than the transcript mentioned "OpenKnowledge" or a knowledge vault. That phrase appears only in the owner's global CLAUDE.md.

| | A: base flags | B: base flags + `--safe-mode` |
| --- | --- | --- |
| `tools` / `mcp_servers` | `[]` / `[]` | `[]` / `[]` |
| `apiKeySource` | `none` | `none` |
| `memory_paths` in init | `auto` present | absent |
| skills / agents / plugins | 51 / 5 / 6 | 19 / 4 / 4 |
| `tool_use` / denials / turns | 0 / [] / 1 | 0 / [] / 1 |
| Exit code / stderr | 0 / empty | 0 / empty |
| Output | One ```json fence, parses, `memory_id: null` | One ```json fence, parses, `memory_id: null` |
| Sources cited | [101, 102] (agent message cited) | [101] |
| Owner CLAUDE.md visible to model | **true** | **false** |
| cwd afterwards | empty | empty |
| `~/.claude/projects` folder | none created | none created |

Caveats: this is one sample each, and the CLAUDE.md signal is the model's own report. The A/B contrast plus the objective `memory_paths` difference is still strong evidence. Because the instructions said `memory_id` null for `add`, neither call invented IDs, so this does not show whether `--system-prompt` alone fixes ID invention.

## Cleanup

Both temp cwds were confirmed empty and removed with `rmdir`. No `~/.claude/projects/<encoded>` folder existed for either call: there was no match on the encoded path, none on the basename, and zero `-T-tmp-` folders. Only my own scratch files were deleted. No `~/.claude` settings, credentials or `.inoai-connect*` were touched. No bypass or allow flags were used.

## Next

The worker should update the spike doc for findings 1–3. Then update task-0059's Claude flag line to add `--safe-mode` and to handle the optional project folder. That is a planner or owner decision because the task records an owner decision. Re-review after that.

## Suggested skills

- `code-review` (doc-only re-review)
