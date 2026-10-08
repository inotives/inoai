# Agent profile and local skills plan

## Goal

Give every deployed Agent Instance an independent personality, role, and
owner-approved provider-neutral skill set without changing existing
conversation behavior or global provider configuration.

## Invariants

- Existing CLI, Discord, provider, persistence, lock/lease, and Memory Review
  behavior remains unchanged.
- `agent.md` remains the canonical human-authored profile in each runtime home.
- Skills are local to a runtime home; agents cannot install or enable skills.
- Skill execution never bypasses provider sandbox, network, or approval policy.
- Credentials remain in `.env` and are never copied into profiles, manifests,
  skill instructions, logs, Discord, or persisted events.
- Profile and skill changes are owner-controlled and auditable.

## Runtime-home layout

```text
.inoai-connect-<name>/
├── agent.md
├── skills/
│   └── <skill-id>/
│       ├── SKILL.md
│       ├── skill.yaml
│       └── scripts/ and references/
├── skills-enabled.json
└── .env
```

`skills-enabled.json` stores approved package IDs, versions, hashes,
capability snapshots, approver, and approval timestamps. It does not store
credentials or arbitrary tool arguments.

## Implementation slices

1. Add the profile template, required-section validator, local profile command,
   and next-Turn reload behavior.
2. Define and validate `skill.yaml`, package hashes, capability vocabulary, and
   `skills-enabled.json`.
3. Add the owner-only `inoai skills install/enable/disable/update` workflow
   around local skills.sh installation and runtime-home placement.
4. Add provider-neutral skill discovery, enabled-skill index generation, and
   progressive Turn loading with automatic and explicit selection.
5. Integrate script working-directory and policy checks without bypassing
   provider sandbox or approvals.
6. Add focused profile/manifest/loader/security tests, update setup docs, and
   run integrated behavior verification.

## Acceptance criteria

- A new runtime home receives a valid default `agent.md`.
- Invalid profiles fail validation before new work is accepted.
- Profile edits apply on the next Turn without restart.
- Skills installed for one runtime home are invisible to another runtime home.
- A changed skill hash/version requires reapproval.
- Unknown manifest capabilities fail closed.
- Disabled or unknown skills cannot be selected.
- Full skill instructions load only for a selected enabled skill.
- Skill scripts run from the project workspace under the configured provider
  policy.
- Existing test suites and live Discord behavior remain unchanged.
