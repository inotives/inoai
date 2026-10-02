---
agent: reviewer
role: reviewer
tool: claude
task: task-0039
task_title: "Phase 5a: Claude CLI headless contract spike"
status: handoff
---

# task-0039 reviewer handoff

Reviewed `docs/phase-5a-claude-cli-spike.md` against task-0039, Phase 5a in `docs/implementation-phases.md`, the proposal's "Claude runtime (Phase 5a)" section, ADRs 0002, 0003, 0007, and 0008, and the downstream tasks 0042, 0043, 0044, and 0046. I did not change any task status or implementation files.

Verdict: **findings**. There is one medium finding and three low ones. None of them invalidates the spike's core conclusions. Permission denials and the subscription credential source are both observable, so ADR 0008 does not need to be revisited. Finding 1 should be resolved in the doc before task-0044 starts.

## Findings

1. **Medium: the credential guard conflicts with the accepted `CLAUDE_CODE_OAUTH_TOKEN` source.** `docs/phase-5a-claude-cli-spike.md:89` and `:94`.
   - Phase 5a task 7 and task-0044 require accepting both the subscription `/login` and a `CLAUDE_CODE_OAUTH_TOKEN` subscription token.
   - The spike's proposed guard requires `authMethod === "claude.ai"`. It describes `oauth_token` only as "an auth-token env or a non-subscription token".
   - The doc never says what `claude auth status --json` or the init `apiKeySource` reports for `CLAUDE_CODE_OAUTH_TOKEN`. It also never says how to tell that token apart from `ANTHROPIC_AUTH_TOKEN`.
   - A task-0044 worker following line 94 would refuse a source the plan accepts. Or, guessing, it might accept every `oauth_token`, including a non-subscription token.
   - Fix: record this as an explicit unknown in sections 5 and "Open questions", and qualify the proposed guard. The planner should decide whether task-0044 can rely on the bundle logic or needs owner-run evidence. I did not inspect the binary myself, because a sandbox classifier denied it as credential exploration.
2. **Low: snapshot default versus "agent.md on every Turn".** `docs/phase-5a-claude-cli-spike.md:52`, `:145`.
   - Because `--system-prompt-snapshot` defaults to `on`, appending `agent.md` on every Turn (Phase 5a task 4) does not change resumed Sessions. The doc correctly hands this to "the adapter task".
   - It is really a product decision: should `agent.md` edits reach existing threads? The planner or owner should settle it before task-0042 starts, so the adapter worker does not choose silently.
3. **Low: an interrupt with no cancel requested is unmapped.** `docs/phase-5a-claude-cli-spike.md:133`.
   - The table maps `aborted_streaming` to `cancelled` only "with a cancel requested". It does not say that `aborted_streaming` without an owner cancel (for example a shutdown or an external signal) should be `uncertain`, not replay-safe, under ADR 0002.
   - Line 153 hints at this for tool calls only. Codex has the same rule (`src/codex-runtime.ts:95` checks `cancelRequested`), so the adapter will probably get it right, but the row is easy to misread.
4. **Low: the probe leaves a project folder behind on every startup.** `docs/phase-5a-claude-cli-spike.md:141`.
   - With `--no-session-persistence`, `~/.claude/projects/<encoded-cwd>/memory/` is still created (I confirmed this myself). The doc tells the probe to "expect this rather than clean it up".
   - Every startup probe uses a new `mktemp -d` cwd, so empty folders pile up in the owner's `~/.claude/projects/`.
   - task-0046 says "otherwise remove only the probe's own temporary project storage". The planner should say whether the probe removes its own empty encoded-cwd folder, by literal path and only if it is empty.

Residual gap (not a finding, outside task-0039 scope): task-0046 needs "tools disabled", and the spike did not verify which flag does that. The task-0046 worker must check it.

## Checklist results

- Every scope bullet is answered or explicitly marked unknown: event shapes, session/resume/unknown resume, append prompt and model, denials, credential source, SIGINT, auth/usage (expired auth and usage limit are explicit unknowns), and persistence. The CLI version `2.1.287` is recorded at `:4`. Finding 1 is a gap relative to a downstream requirement, not a missing scope bullet.
- Redaction greps on the doc, the worker handoff, and the task file found no emails, no `@`, no UUIDs, no `sk-`, and no 32+ character tokens. `token` hits are prose or flag names only. Tool-use IDs are `toolu_<redacted>`. No home paths or usernames appear. Identity fields from `auth status` are `<redacted>`. `subscriptionType:"team"` is kept, which is not identifying.
- Consistency: the claims match each other and match the `RuntimeFailureKind` values in `src/agent-runtime.ts:14`. Classifying a Turn from the `result` event rather than the exit code is well supported: SIGINT exits 0 while not-logged-in exits 1 with `subtype:"success"`.
- Git: no `src/` changes. The tracked modified docs (AGENTS.md, README.md, the proposal, the phases doc, plan-review) were already in the planner's starting state. Task-0039 added only the untracked spike doc, its task Notes, and the worker handoff. `git diff --check` is clean, and a whitespace check on the untracked spike doc is clean.

## Independent spot checks

All three checks ran in one probe from a fresh `mktemp -d` cwd:

```text
claude -p --output-format stream-json --verbose --no-session-persistence --permission-prompts none --model haiku "Use the Bash tool to run exactly: touch probe.txt . Then say done."
```

No bypass flags, allow rules, or settings changes were used.

- (a) Denial: I saw a `system/permission_denied` event (`tool_name:"Bash"`), and `result.permission_denials` listed `Bash`. The result was `subtype:"success"`, `is_error:false`, `terminal_reason:"completed"`, with exit 0. `probe.txt` was not created. **Confirmed.**
- (b) Init showed `apiKeySource:"none"`, `permissionMode:"default"`, `model:"claude-haiku-4-5-20251001"`, and `claude_code_version:"2.1.287"`. **Confirmed.**
- (c) No session `.jsonl` was written. The encoded-cwd project folder was created containing only an empty `memory/`. **Confirmed**, matching `:141`.
- Cleanup: I confirmed the folder held only the empty `memory/`, then removed `~/.claude/projects/-private-var-folders-…-T-tmp-xObNILRsHg` and the temp dir by literal path. I did not run `claude auth status`, and I did not touch any `.inoai-connect*` home, Claude setting, or credential.

## Next

Manager: send finding 1 back to the worker so it can update the doc with an explicit unknown and a qualified guard. Alternatively, the planner can accept it as a known gap and carry it into task-0044. Findings 2–4 need planner decisions that should be recorded before tasks 0042 and 0046 start.

## Suggested skills

- `grilling` for the planner or owner decisions in findings 1, 2, and 4.
