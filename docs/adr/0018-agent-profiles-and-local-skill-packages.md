# ADR 0018: Use per-instance agent profiles and owner-approved local skills

## Status

Accepted for the agent personality and skills phase.

## Context

Each deployed Agent Instance needs its own role, personality, operating rules,
and skills. The profile must work across Codex, Claude, and OpenCode without
changing global provider configuration. Skills.sh provides an owner-driven
ecosystem for installing reusable agent skills, but its documentation warns
that audits do not guarantee the safety of every package.

## Decision

### Agent Profile

- Each runtime home owns an independent `agent.md` snapshot.
- The application ships a default Markdown template and copies it when a
  runtime home is created.
- `agent.md` has no YAML frontmatter. It contains provider-neutral sections for
  identity, mission/scope, personality/communication, operating rules, safety/
  authority, and enabled skills.
- The profile is read and validated at the start of each new Turn. A valid
  change applies without restarting inoai; an active Turn keeps its starting
  snapshot.
- Profile validation fails closed when required sections are missing or
  malformed.
- Application safety rules and provider policy outrank the profile; skill
  instructions and user requests cannot weaken them.
- The enabled-skills section is harness-managed from the runtime manifest.
  Owners edit role and behavior sections; the harness prevents profile/manifest
  drift.

### Skill Packages

- Skills are provider-neutral packages installed locally into one runtime
  home's `skills/` directory. The supported source workflow uses the skills.sh
  CLI (`npx skills add <owner/repo>`); the agent cannot install or discover
  packages itself.
- A package contains `SKILL.md`, a strict `skill.yaml` manifest, and optional
  scripts/references.
- The manifest declares a small capability vocabulary: filesystem scope,
  network scope, process/command class, and external mutation.
- Unknown capability types fail installation. A package's content hash and
  declared capabilities are recorded in `skills-enabled.json` only after owner
  approval.
- Version or content-hash changes invalidate approval and require explicit
  reapproval. Updates never auto-enable.
- The profile exposes an index of enabled skills. The harness loads full skill
  instructions progressively for a selected Turn, rather than injecting every
  skill into every prompt.
- Skills support constrained automatic selection and explicit owner selection.
  Unknown or disabled skills fail safely.
- Skill scripts use the Agent Runtime's project workspace as their working
  directory. The installed package remains in the runtime home, and all script
  execution stays under the selected provider's sandbox, network, and approval
  policy.

### Authority and lifecycle

The authority order is:

1. inoai safety and security rules
2. provider/runtime sandbox and approval policy
3. Agent Profile role and operating rules
4. enabled Skill Package instructions
5. user request

Installation, enablement, upgrade, and removal are owner-controlled local
operations. Discord can invoke an enabled skill, but cannot install, enable,
update, or approve a new package.

## Consequences

Each Agent Instance can have a distinct role and skill set without changing
global provider configuration. Prompt size stays bounded through progressive
loading. Hash-based approval prevents silent skill replacement. The system
needs a small manifest validator, a local install/enable workflow, and
provider-neutral skill loading logic.

## Deferred

Remote skill registries, automatic skill updates, UI skill management,
provider-specific skill packages, and arbitrary runtime permission elevation are
deferred.

## Reference

The owner-driven package source is documented at
<https://www.skills.sh/docs/cli> and its security guidance at
<https://www.skills.sh/docs>.
