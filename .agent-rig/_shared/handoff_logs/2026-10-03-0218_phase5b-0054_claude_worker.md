---
agent: worker
role: worker
tool: claude
task: task-0054
task_title: "Phase 5b: README OpenCode setup"
status: handoff
---

# task-0054 worker handoff

The task is set to `review`. The change is docs only (README.md). Nothing is staged or committed, and I read no `.inoai-connect*/.env`.

## Change

- New `## OpenCode runtime` section after `## Claude runtime`, with these subsections:
  - Prerequisites: Node 22+; `opencode` on the PATH of the shell that runs `npm start`, with the default install in `~/.opencode/bin`; a Discord bot.
  - Setup: validate, copy `.env.sample`, set `AGENT_PROVIDER=opencode`, validate, start, all with `--connect-dir .inoai-connect-opencode`. Validation is offline. Startup runs `opencode --version` and fails with `OpenCode CLI is unavailable`.
  - Data and billing (ADR 0009): no model is passed and there is no guard. Free Zen sends prompts and project context to opencode.ai. A provider configured later is used and billed as configured. The free-tier "from within OpenCode" risk would surface as the authentication notice. No `--auto`/`--yolo`/`--dangerously-skip-permissions`.
  - Behavior: a standalone run per Turn, with `--session` resume. Sessions appear in OpenCode's session list for the deployment folder (`project_path` = `dirname(runtimeHome)`). Covers native `AGENTS.md`, the delimited `agent.md` block on every Turn, the fail-closed permission notice, global FIFO with no probe, and the mismatch and missing-session notices that point to `/inoai reset`.
  - Running alongside other homes: one bot per concurrently running instance.
- Added `.inoai-connect-opencode/` to the Agent Instances example.
- Deployment layout: `AGENTS.md` is now described as guidance for Codex and OpenCode.
- The status line is unchanged ("Phase 5b (OpenCode) is in progress"). No text called OpenCode deferred or future.

## Checks

- `git diff --check` is clean.
- These strings grep-match src/: `OpenCode CLI is unavailable`, `--version`, `--session`, and `--standalone` (src/opencode-runtime.ts); `AGENT_PROVIDER` / `opencode` (src/config.ts); `--connect-dir` (src/index.ts). The `validate` and `start` scripts are in package.json.
- The link `docs/adr/0009-opencode-uses-its-configured-provider.md` exists, and the anchor `#running-alongside-other-homes` matches its heading.

## Review focus

- Wording accuracy against the notices in src/runtime-turn.ts, src/conversation-worker.ts, and src/approval-relay.ts, and the authenticationNotice in src/opencode-runtime.ts.
