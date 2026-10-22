# AGENT Guidelines

Use this file as the first routing guide when working in this repository.

inoai is a local TypeScript bridge between a chat transport and a locally authenticated coding-agent CLI. V1 uses Discord with Codex CLI (the owner's ChatGPT sign-in) or, from Phase 5a, Claude CLI (the owner's Claude subscription sign-in), or, from Phase 5b, OpenCode (its configured provider; free OpenCode Zen today). Codex and Claude never use the OpenAI or Anthropic API.

## Trinary Agents workflow

Use the installed `trinary-agents` skill for the active Agent Tasks phase. Its
local, ignored `trinary-workspace/` holds the approved feature plan, task
briefs, statuses, dashboard, and append-only handoffs. The feature and task
READMEs are the source of truth for this phase.

The project-manager selects one dependency-free task at a time, changes task
status, and records handoffs. A worker implements only the assigned scope and
returns evidence. An independent reviewer checks the diff and returns a
verdict. The project-manager processes the verdict before selecting the next
task. Follow the skill's task cycle and human acceptance gate.

## Source of truth

- Read `docs/discord-codex-cli-harness-proposal.md` for V1 behavior and boundaries.
- Read `docs/implementation-phases.md` before implementation work.
- Read `docs/sqlite-schema.md` before changing persistence.
- Read `CONTEXT.md` for domain terms and `docs/archived/plan-review.md` for accepted historical decisions; check the current ADRs for authoritative decisions.
- For the Agent Tasks phase, read the approved feature and task READMEs in `trinary-workspace/` before changing code.
- For SPA UI decisions, also read `docs/archived/spa-agent-ui-phase-plan.md` and `docs/adr/0021-health-timeline-history.md`.
- Do not start live SPA data-bound tasks until the fixture-driven prototype has
  explicit human approval in its task handoff.

## Task workflow

Before starting a Trinary task, read its README, check `depends_on` and
`status`, and read the latest handoffs. The project-manager owns workflow
records. Workers and reviewers return handoff content without changing task
status, dependencies, or canonical handoff files.

## Architecture

- The portable core and local read-only SPA UI are separate applications.
- A deployment folder contains the core executable, sibling SPA UI bundle, and one or more ignored `.inoai-connect*` runtime homes.
- Each runtime home is an independent Agent Instance with its own `.env`, `agent.md`, SQLite archive, Memory, approvals, and lock file.
- Each runtime home selects one chat transport and one agent-runtime provider. Discord is the only V1 transport; Codex, Claude CLI (Phase 5a), and OpenCode (Phase 5b) are the V1 agent runtimes. Provider seams are deliberately narrow for later adapters.
- The SPA UI reads only the selected runtime home's SQLite file through its local read-only data boundary. It must never read `.env` or expose credentials.

### Live SQLite maintenance

- While the Agent Instance is running, the local CLI supports `allowlist:add`, `allowlist:disable`, `memory add`, `memory delete`, and read-only `memory list` through short-lived maintenance connections. Use `--connect-dir` to select the runtime home.
- The Runtime Home Lock remains held by the runtime. Do not stop or restart it, remove or alter its lock, or edit its SQLite files directly to run these commands.
- SQLite allows one writer at a time. A maintenance write can wait up to the 5-second busy timeout; if it returns the retryable busy error, retry the command. The CLI does not queue the operation indefinitely.
- Allowlist changes affect later authorization checks. Memory changes affect later prompt composition only; they do not change an already-composed or in-flight Turn. `memory list` is read-only.
- This support does not extend to other database-writing commands, UI writes, or IPC. The SPA UI remains read-only. Stopped and fresh homes retain their normal startup behavior.

## Technical English

Use short, direct sentences in planning documents, tasks, handoffs, ADRs, and
agent instructions. Use one term for one concept. Prefer active voice and
common words. Keep paths, identifiers, and command names exact. State
conditions, actions, and expected results clearly.

## Working rules

- Follow the project-local Trinary skill for its workflow records and role boundaries.
- Keep edits scoped to the assigned task. Do not overwrite another agent's work unless the task explicitly requires it.
- Prefer project-local commands and documentation over global memory.
- Treat SQLite as the durable source of truth. Preserve audit fields and use soft deletion; do not introduce physical deletes for persisted records.
- Keep per-Session turns FIFO. Never process two turns for the same Agent Session concurrently.
- Preserve the configured CLI's skills, MCP servers, sandbox, and approval policy. Never silently elevate permissions.
- Every bot ignores bot-authored messages. Cross-agent mentions inside a thread are not handoffs.
- Keep secrets out of SQLite, logs, Discord, UI data, and committed files.
- Do not modify global Codex, Claude, or OpenCode configuration as part of this project.

## Handoff

The project-manager records timestamped handoffs in the assigned Trinary task's
`handoffs/` folder. Keep them append-only. If blocked, record the reason and
the needed human action in a project-manager handoff.

## Project phase workflow

1. Start a phase on a feature branch. Use the Trinary skill to clarify material decisions and record the approved plan.
2. Split the plan into dependency-tracked tasks. Set only tasks with completed dependencies to `ready`.
3. Dispatch one worker and one independent reviewer per task. The project-manager records their handoffs and status changes.
4. Run the integrated acceptance checks after all tasks are done. Record the human's final acceptance separately.
5. Do not push, merge, or publish without the user's explicit request.

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

V1 targets macOS, owner-only access, local SQLite, Discord, Codex, Claude CLI (Phase 5a), OpenCode (Phase 5b), and the accepted implementation phases. The SPA UI is local-only and read-only in its initial phase. The Agent Tasks phase is active. Defer remote UI access, family access, cross-Agent-Instance Memory sharing, and other adapters until their phase is explicitly started.
