# AGENT Guidelines

This project uses AgentRig. When Codex, Claude, OpenCode, or another terminal agent starts in this repository, use this file as the first routing guide.

inoai is a local TypeScript bridge between a chat transport and a locally authenticated coding-agent CLI. V1 uses Discord with Codex CLI (the owner's ChatGPT sign-in) or, from Phase 5a, Claude CLI (the owner's Claude subscription sign-in), or, from Phase 5b, OpenCode (its configured provider; free OpenCode Zen today). Codex and Claude never use the OpenAI or Anthropic API.

## AgentRig startup

Apply this section when `.agent-rig/` exists.

1. Find the agent name.
   - Prefer the human-provided name from the launch command or terminal note.
   - If no name is supplied, ask which `.agent-rig/<agent>/` folder to use.
2. Read local role files first, when present:
   - `.agent-rig/<agent>/instructions.md`
   - `.agent-rig/<agent>/context.md`
   - `.agent-rig/<agent>/agent.toml`
3. Read shared project context next, when present:
   - `.agent-rig/_shared/context.md`
   - `.agent-rig/_shared/agent-rig.json`
   - `.agent-rig/_shared/session.json`
4. Prefer role-local assets over shared assets, then global assets:
   - `.agent-rig/<agent>/skills/` and `.agent-rig/<agent>/tools/`
   - `.agent-rig/_shared/skills/` and `.agent-rig/_shared/tools/`

Project-local AgentRig instructions, skills, and tools take precedence over similar global versions unless the user directs otherwise.

### AgentRig workflow storage

- This repository uses AgentRig `0.1.9` with SQLite as the canonical workflow provider.
- The active provider is recorded in `.agent-rig/_shared/agent-rig.json`; use `agent-rig status --json` to verify it before workflow work.
- The live task and handoff store is `.agent-rig/_shared/workflow.sqlite`. Use AgentRig commands for task/status/handoff mutations; do not edit SQLite directly.
- The original Markdown task and task-linked handoff files remain historical reference material after migration. Do not switch the provider back to Markdown without an explicit migration decision.
- A safety backup can be created with `agent-rig workflow backup --output .agent-rig/_shared/workflow.sqlite.backup`.
- Phase-level planner handoffs that do not reference a task are preserved in `.agent-rig/_shared/phase_handoffs/`; they are reference documents, not live task handoffs.

## Source of truth

- Read `docs/discord-codex-cli-harness-proposal.md` for V1 behavior and boundaries.
- Read `docs/implementation-phases.md` before implementation work.
- Read `docs/sqlite-schema.md` before changing persistence.
- Read `CONTEXT.md` for domain terms and `docs/plan-review.md` for accepted decisions.
- If an AgentRig task exists, its SQLite task record is the source of truth for its assigned scope. Any migrated Markdown task file is historical reference only.
- For the current SPA phase, also read `docs/spa-agent-ui-phase-plan.md` and `docs/adr/0021-health-timeline-history.md`.
- Do not start live SPA data-bound tasks until the fixture-driven prototype has
  an explicit human approval recorded in its AgentRig handoff.

## Task workflow

AgentRig task briefs are read through the project-local AgentRig commands.
Migrated Markdown files in `.agent-rig/_shared/tasks/` are historical reference
only when SQLite is active.

Before starting a task:

1. Read the assigned task with `agent-rig tasks show <task-id>`.
2. Check `depends_on` and `status`.
3. Work only on tasks ready for the current role.
4. Update task and handoff state through the project-local AgentRig commands.

```text
agent-rig tasks
agent-rig tasks next --agent <agent-name>
agent-rig tasks next --agent <agent-name> --claim
agent-rig tasks show <task-id>
agent-rig tasks create <title> --body-file <path>
agent-rig tasks update-body <task-id> --body-file <path>
agent-rig tasks set-status <task-id> <status>
agent-rig tasks done <task-id> --message "<summary>"
agent-rig tasks block <task-id> --reason "<reason>"
agent-rig tasks handoff <task-id> --sender <role> --recipient <role> --status <status> --message "<summary>"
```

## Architecture

- The portable core and local read-only SPA UI are separate applications.
- A deployment folder contains the core executable, sibling SPA UI bundle, and one or more ignored `.inoai-connect*` runtime homes.
- Each runtime home is an independent Agent Instance with its own `.env`, `agent.md`, SQLite archive, Memory, approvals, and lock file.
- Each runtime home selects one chat transport and one agent-runtime provider. Discord is the only V1 transport; Codex, Claude CLI (Phase 5a), and OpenCode (Phase 5b) are the V1 agent runtimes. Provider seams are deliberately narrow for later adapters.
- The SPA UI reads only the selected runtime home's SQLite file through its local read-only data boundary. It must never read `.env` or expose credentials.

## Technical English

Use short, direct sentences in planning documents, tasks, handoffs, ADRs, and
agent instructions. Use one term for one concept. Prefer active voice and
common words. Keep paths, identifiers, and command names exact. State
conditions, actions, and expected results clearly.

## Working rules

- Follow `.agent-rig/<agent>/instructions.md` over this general scaffold.
- Keep edits scoped to the assigned task. Do not overwrite another agent's work unless the task explicitly requires it.
- Prefer project-local commands and documentation over global memory.
- Treat SQLite as the durable source of truth. Preserve audit fields and use soft deletion; do not introduce physical deletes for persisted records.
- Keep per-Session turns FIFO. Never process two turns for the same Agent Session concurrently.
- Preserve the configured CLI's skills, MCP servers, sandbox, and approval policy. Never silently elevate permissions.
- Every bot ignores bot-authored messages. Cross-agent mentions inside a thread are not handoffs.
- Keep secrets out of SQLite, logs, Discord, UI data, and committed files.
- Do not modify global Codex, Claude, or OpenCode configuration as part of this project.

## Handoff

When AgentRig is active, record task handoffs with `agent-rig tasks handoff`.
The SQLite handoff record is canonical. Do not edit migrated Markdown task or
handoff files directly. If blocked, record the blocker in the AgentRig task
and send a `blocked` handoff to the planner.

Planner phase summaries without a task ID belong in `.agent-rig/_shared/phase_handoffs/` and must not be presented as task-level worker or reviewer handoffs.

## Project phase workflow

1. Start a new phase with `grill-with-docs`: read the phase and existing docs, ask one decision at a time with a recommendation, and record material tradeoffs in an ADR.
2. Finalize the phase documentation before implementation. Check the current branch; when starting from `main`, create and switch to a phase feature branch before creating tasks or changing project files.
3. Split the approved phase into AgentRig tasks with explicit `depends_on` edges and one final integrated-review task. Every task must include Context, Goal, Scope, Planner Notes, Implementation Plan, and Acceptance Criteria.
4. Set only dependency-free work to `ready`. Keep every downstream task `blocked`; satisfying a dependency does not automatically authorize starting all newly eligible work.
5. Drive implementation one task at a time through this manager loop:
   1. Unblock and claim the next eligible worker task.
   2. Spawn a worker agent. It reads the worker role, task, source docs, and relevant prior handoff; changes only its assigned scope; runs focused tests, typecheck, build, and diff checks; then sets the task to `review` and sends a worker handoff. It does not commit or push.
   3. Spawn an independent reviewer agent. It reads the reviewer role, task, worker handoff, source docs, and current diff; runs focused checks; makes no implementation edits; and sends a reviewer handoff with `approved`, `changes_requested`, or `blocked` status.
   4. If review is clean, record the `approved` handoff decision, mark the task `done`, and unblock only the next selected dependent task.
   5. If review requests changes, keep the task in `review` and spawn the same worker to read both handoffs, implement the focused fix, add regression coverage, verify it, and send a new `review` handoff. Re-run independent review until clean; do not unlock downstream work meanwhile. If the reviewer reports `blocked`, set the task to `blocked` and resolve the blocker with the human.
6. After all worker tasks pass task-level review, unblock and claim the final reviewer task. Run the phase-wide acceptance checks against the integrated diff and mark it `done` only when clean.
7. Write the planner phase handoff with verification evidence and any resolved review findings. After merge, archive the completed phase document under `docs/_archived/` before beginning the next phase.
8. Commit, push, or open a pull request only when the user explicitly requests it.

## Coding guidelines

### Think before coding

- State assumptions. Surface meaningful alternatives and tradeoffs rather than silently choosing one.
- Ask when a missing decision materially changes scope, safety, or architecture.
- Define success criteria and a brief verification plan for multi-step work.

### Simplicity first

- Build the minimum that solves the requested problem.
- Do not add speculative flexibility, single-use abstractions, or unrelated error handling.
- Prefer existing project patterns and Node built-ins before new dependencies.

### Surgical changes

- Touch only files and lines needed for the task.
- Do not refactor or clean up unrelated code.
- Remove only imports, variables, or functions made unused by the current change.

### Goal-driven execution

For non-trivial work, state concise verifiable steps:

```text
1. <step> → verify: <check>
2. <step> → verify: <check>
```

Add or update the smallest focused test for non-trivial behavior. Use isolated temporary runtime homes in tests; never read or modify a developer's repository-root `.inoai-connect*` data.

## Runtime personality

This file is repository guidance, not an agent persona. The core copies a default template into each runtime home's `.inoai-connect*/agent.md` and supplies that file to the selected Agent Runtime. Edit the runtime `agent.md` for role-specific behavior such as planner or designer.

## V1 boundaries

V1 targets macOS, owner-only access, local SQLite, Discord, Codex, Claude CLI (Phase 5a), OpenCode (Phase 5b), and the accepted implementation phases. The SPA UI is local-only and read-only in its initial phase. Defer scheduled Tasks, remote UI access, family access, cross-Agent-Instance Memory sharing, and other adapters until their phase is explicitly started.
