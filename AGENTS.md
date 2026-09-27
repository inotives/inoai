# AGENT Guidelines

This project uses AgentRig. When Codex, Claude, OpenCode, or another terminal agent starts in this repository, use this file as the first routing guide.

inoai is a local TypeScript bridge between a chat transport and a locally authenticated coding-agent CLI. V1 uses Discord and Codex CLI with the owner's ChatGPT sign-in; it does not use the OpenAI API.

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

## Source of truth

- Read `docs/discord-codex-cli-harness-proposal.md` for V1 behavior and boundaries.
- Read `docs/implementation-phases.md` before implementation work.
- Read `docs/sqlite-schema.md` before changing persistence.
- Read `CONTEXT.md` for domain terms and `docs/plan-review.md` for accepted decisions.
- If an AgentRig task exists, its task file is the source of truth for its assigned scope.

## Task workflow

Shared AgentRig tasks live in `.agent-rig/_shared/tasks/`.

Before starting a task:

1. Read the assigned task file and its YAML frontmatter.
2. Check `depends_on` and `status`.
3. Work only on tasks ready for the current role.
4. Update task state through AgentRig commands when available.

```text
agent-rig tasks
agent-rig tasks next --agent <agent-name>
agent-rig tasks next --agent <agent-name> --claim
agent-rig tasks show <task-id>
agent-rig tasks set-status <task-id> <status>
agent-rig tasks done <task-id> --message "<summary>"
agent-rig tasks block <task-id> --reason "<reason>"
```

## Architecture

- The portable core and Electron analytics UI are separate applications.
- A deployment folder contains the core executable, sibling Electron bundle, and one or more ignored `.inoai-connect*` runtime homes.
- Each runtime home is an independent Agent Instance with its own `.env`, `agent.md`, SQLite archive, Memory, approvals, and lock file.
- Each runtime home selects one chat transport and one agent-runtime provider. Discord and Codex are the only V1 implementations; provider seams are deliberately narrow for later adapters.
- The Electron UI reads a selected runtime home's SQLite file directly. It must never read `.env` or expose credentials.

## Working rules

- Follow `.agent-rig/<agent>/instructions.md` over this general scaffold.
- Keep edits scoped to the assigned task. Do not overwrite another agent's work unless the task explicitly requires it.
- Prefer project-local commands and documentation over global memory.
- Treat SQLite as the durable source of truth. Preserve audit fields and use soft deletion; do not introduce physical deletes for persisted records.
- Keep per-Session turns FIFO. Never process two turns for the same Agent Session concurrently.
- Preserve the configured CLI's skills, MCP servers, sandbox, and approval policy. Never silently elevate permissions.
- Every bot ignores bot-authored messages. Cross-agent mentions inside a thread are not handoffs.
- Keep secrets out of SQLite, logs, Discord, UI data, and committed files.
- Do not modify global Codex configuration as part of this project.

## Handoff

When AgentRig is active, write handoffs to `.agent-rig/_shared/handoff_logs/` using:

```text
<date-YYYY-MM-DD-hhmm>_<session_id>_<tool>_<role>.md
```

Include YAML frontmatter with `agent`, `role`, `tool`, `task`, `task_title`, and `status` (`done`, `blocked`, or `handoff`). If blocked, record the blocker in the AgentRig task and write a handoff.

## Project phase workflow

1. Start a new phase with `grill-with-docs`: read the phase and existing docs, ask one decision at a time with a recommendation, and record material tradeoffs in an ADR.
2. Finalize the phase documentation before implementation. Commit or push only when the user explicitly requests it.
3. Implement only the finalized phase scope, run its acceptance checks, and report the verified result.
4. Complete the AgentRig task and create a handoff when the phase or assigned role is complete.

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

V1 targets macOS, owner-only access, local SQLite, Discord, Codex, and the accepted implementation phases. Defer scheduled Tasks, remote UI, family access, cross-Agent-Instance Memory sharing, and non-Codex adapters until their phase is explicitly started.
