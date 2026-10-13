# AgentRig Planning And Delivery Workflow

Use this workflow for phase and feature work.

## 0. Choose Workflow Storage

- New workspaces default to Markdown:
  `agent-rig init --yes`.
- New workspaces can start directly with SQLite:
  `agent-rig init --yes --workflow-store sqlite`.
- Existing Markdown workspaces migrate with:
  `agent-rig workflow migrate --to sqlite`.
- After migration, SQLite is canonical and migrated Markdown is historical
  reference only. Only the planner mutates tasks and handoffs through the
  `agent-rig tasks ...` CLI.

## 1. Plan With The Human

- The planner and human clarify goals, constraints, trade-offs, and acceptance
  criteria before implementation tasks are created.
- Read the project docs and relevant phase docs first.
- Ask one decision question at a time and record accepted decisions.
- Create ADRs only for meaningful, hard-to-reverse trade-offs.
- Keep the phase plan, implementation plan, ADRs, and acceptance documentation
  as canonical repository files under `docs/`.
- Do not migrate planning documents into the workflow store; SQLite is for live
  operational tasks and handoff conversations only.

For GitHub Issue planning, use this sequence:

1. `agent-rig plan github-issue` lists open issues. Discovery does not create
   workflow tasks.
2. `agent-rig plan github-issue <number>` selects one issue.
3. `agent-rig plan branch <number>` creates the issue branch and plan.
4. Review the plan with the human. AgentRig prints a GitHub compare link and
   does not create a pull request automatically.
5. `agent-rig plan approve <number>` records human approval.
6. `agent-rig plan tasks <number>` creates workflow tasks only after approval.

GitHub planning requires the GitHub CLI (`gh`) and authentication. Normal
local workflows do not require GitHub CLI access. Use
`agent-rig plan resume <number>` for an existing unapproved plan.

## 2. Create Dependency-Gated Tasks

- Break the approved plan into small, independently verifiable tasks.
- Add explicit `depends_on` edges and one final integrated-review task.
- Set only dependency-free foundation tasks to `ready`.
- Keep downstream tasks `blocked`; dependency metadata does not authorize work
  by itself.

## 3. Run The Planner-Manager Worker And Reviewer Flow

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

## 4. Replan When Reality Changes The Plan

- If implementation or review exposes a limitation that changes scope,
  architecture, or acceptance criteria, pause the affected task graph.
- Return to the planner and human. Do not silently invent a workaround or
  continue downstream work from a stale plan.
- Update the canonical phase/implementation documents under `docs/` and add an
  ADR when the change is a meaningful trade-off.
- Create new tasks or revise dependencies only after the updated plan is
  accepted. Keep affected downstream tasks `blocked` until the revised
  predecessors pass review.

## 5. Finish The Phase

- After all implementation tasks pass task-level review, the planner-manager
  directly runs the final integrated review against the complete diff and phase
  acceptance checks.
- If the integrated review finds an issue, the planner-manager routes the
  `changes_requested` repair through the same worker and independent reviewer
  cycle, then repeats the integrated review. The planner-manager owns final
  phase acceptance.
- Record planner completion evidence and resolved findings. Do not create a
  `planner -> planner` self-handoff.
- Keep planner integrated review and human final review as separate gates.
  Route human findings through the planner to the worker. Record human acceptance.
- The planner commits completed tasks through the commit gate above.
  Push or open a pull request only when the human explicitly asks.
- Complete the final human end-to-end check for discovery, plan review,
  approval, task generation, and the worker-reviewer flow before marking the
  phase complete.
