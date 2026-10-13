# Project Context

Project: ino-ai
Type: unknown project

README: ./README.md

<!-- agent-rig:managed-context:start -->
# AgentRig Coordination Contract
The profile token and handoff recipient remain `planner`. The planner-manager
is the only task and handoff state writer for both Markdown and SQLite.
Workers and reviewers return handoff content to the planner. They do not write
task status, dependencies, canonical handoffs, or workflow-store files. They
do not commit, push, or start nested AgentRig loops.

For each selected task:

1. The planner checks task status and dependencies, selects one eligible task,
   and sets it to `in_progress` before launching one worker.
2. The worker reads the supplied instructions and task, makes scoped changes,
   runs focused checks, and returns `review` to `reviewer`, or `blocked` to
   `planner`. The planner records the handoff and sets `review` or `blocked`.
3. The planner launches one independent reviewer in the same project workspace.
   The reviewer inspects the task, worker handoff, docs, and current diff. It
   does not edit implementation files or repository notes. It runs focused
   checks and returns exactly one decision: `approved` to `planner`,
   `changes_requested` to `worker`, or `blocked` to `planner`.
4. The planner records the reviewer handoff. For `approved`, it marks the task
   `done` with completion evidence. The next task stays `blocked` until the
   commit gate passes.
   For `changes_requested`, it sets `review -> in_progress` before sending
   the same worker the focused findings. The worker reads both handoffs,
   repairs the task, and returns a new `review` handoff. The planner records
   it, sets `review`, and launches independent review again. For `blocked`,
   the planner sets `blocked` and resolves the blocker with the human.
5. Human findings use `human -> planner: changes_requested`. The planner
   records the findings and sends a focused
   `planner -> worker: changes_requested` handoff. Repairs pass independent review before acceptance.

After independent review and task completion, the planner must pass the commit
gate before selecting, unblocking, or starting the next task:

- Stage only the completed task's changes with explicit paths. Check the staged
  diff and commit with a task-specific message that includes the task ID.
- Verify the commit with `git log -1 --oneline` and `git show --stat HEAD`.
  Confirm that it contains the completed task's changes. Run
  `git status --porcelain` and require a clean working tree before proceeding.
- If commit or verification fails, keep the next task `blocked`. Treat the
  failure as a planner blocker and resolve it before proceeding. Do not include
  unrelated changes or discard them to make the working tree clean.
- Only after the gate passes, select and unblock the next eligible task.
  Do not push automatically. Workers and reviewers must not commit or push.

Child prompt inputs must include the project repository root, complete role
instructions, shared context, the task brief and acceptance criteria, and only
the latest relevant handoffs. Preserve local role precedence. Include the
worker handoff and current diff for the reviewer. Include both worker and
reviewer handoffs for a repair. State the scope, forbidden mutations, required
checks, and output format. Use the same project workspace for both children.
Do not add provider-specific launch flags to this contract.

Return the proposed handoff as Markdown with these six fields:

- **Decision:** `review`, `approved`, `changes_requested`, or `blocked`.
- **Recipient:** `reviewer`, `worker`, or `planner`, as defined above.
- **Summary:** State what changed or what the review concluded.
- **Findings:** List actionable findings with file and line references, or `None`.
- **Evidence:** Give exact check commands, results, and any check that could not run.
- **Requested action:** State the next action for the recipient.

The recipient identifies the next role; the planner receives and records every
child result before routing it. Child failure does not trigger automatic retry.
The planner saves diagnostic output and decides whether to retry or ask the
human. Use `blocked` only for a real task or environment blocker.

### Bounded Investigation

Read the task, acceptance criteria, and latest relevant handoffs. Workers use
CodeGraph when available to locate implementation symbols and callers before
a scoped change. Reviewers inspect the supplied diff first, then use CodeGraph
when available to independently inspect changed symbols, callers, tests, and
nearby behavior. Inspect relevant source and changed files. If CodeGraph is
unavailable or reports stale results, use focused `rg` searches and direct file
inspection.

Use context-mode when available for large files, logs, test output, or generated
data. Otherwise, inspect relevant sections and keep command output bounded.
Run focused behavioral tests with normal test commands. Expand investigation
only when evidence requires it. These optional tools reduce navigation and
context cost. They do not replace source inspection, behavioral verification,
or the handoff and state ownership rules above.

## Safe Operations

These rules are mandatory. A test run once deleted files outside the repository.

- Do not run a command, script, or test that deletes, moves, or overwrites files outside the repository and a temporary directory that you created.
- A test or script that deletes files takes its root directory as a parameter. Tests pass a new temporary directory as the root. Tests never use the home directory, `/`, or the current directory as the root.
- Before you delete a path that comes from a variable, check that the variable is not empty and that its real path is inside the directory that you created.
- Run mutation tests, fault-injection tests, generated scripts, and real agent processes through `.agent-rig/_shared/tools/sandbox-run.sh`, with `HOME` set to a temporary directory.
- A reviewer records `changes_requested` for a test or script that deletes outside a temporary root that it receives as a parameter.
- A planner names the sandbox runner in the brief of every task that deletes files, runs generated code, or starts a real agent.

Call the sandbox runner like this:

```sh
.agent-rig/_shared/tools/sandbox-run.sh --allow-write <directory> -- <command> [arguments]
```

- Give each directory that the command must write to its own `--allow-write <directory>`.
- The runner refuses the home directory and a directory that contains it. Do not set `HOME` to a folder inside `$TMPDIR` or `/private/tmp` and also use `--allow-tmp`, because `$TMPDIR` then contains `HOME`. Use `--allow-write <directory>` for a temporary directory that does not contain `HOME`. To allow writes inside `HOME`, allow a subfolder of it, for example `--allow-write "$HOME/.cache"`.
- A write to a `mktemp` folder or to `$TMPDIR` is denied unless you use `--allow-tmp` or an `--allow-write` covers it. The only error is "Operation not permitted".
- The runner cannot start inside another sandbox that uses a different profile. In that case it exits with status 71 and does not run the command.
<!-- agent-rig:managed-context:end -->
