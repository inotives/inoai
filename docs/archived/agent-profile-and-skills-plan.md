# Agent profile and local skills plan

## Goal

Give every deployed Agent Instance an independent personality, role, and
owner-approved provider-neutral skill set without changing existing
conversation behavior or global provider configuration.

## Invariants

- Existing CLI, Discord, provider, persistence, lock/lease, and Memory Review
  behavior remains unchanged.
- `agent.md` remains the canonical human-authored profile in each runtime home.
- Skills are local to a runtime home; agents cannot install, enable, update,
  disable, or remove skills.
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
3. Add the owner-only `inoai skills add/list/enable/update/disable/remove`
   workflow around remote and local source acquisition and runtime-home
   placement. Keep `install --package-dir` for legacy and test homes.
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

## Owner skill commands

The public CLI targets one Agent Instance with `--agent <name>`, which resolves
to `.inoai-connect-<name>`. `--connect-dir <home>` remains available for
legacy and test homes and cannot be combined with `--agent`.

```text
inoai skills add <skills.sh-page-or-repository-or-local-source> --skill <skill-id> --agent <name>
inoai skills list --agent <name>
inoai skills enable <skill-id> --agent <name>
inoai skills update <skill-id> --agent <name>
inoai skills disable <skill-id> --agent <name>
inoai skills remove <skill-id> --agent <name> --yes
```

`--skill` is mandatory for `add`, including a local repository with more than
one package. A skills.sh page records the page as the source locator and uses
the selected skill. A repository URL or local source records its locator,
selected skill, and resolved revision (`resolved` for remote acquisition or
`working-tree` for local acquisition).

See the [skill-management phase plan](skill-management-phase-plan.md) and
[ADR 0023](../adr/0023-skill-acquisition-and-approval.md) for the workflow
boundary and approval rules.

Acquisition copies a real package into the selected runtime home. If the
package has no `skill.yaml`, inoai creates a conservative manifest with
version `0.0.0` and all capabilities set to `none`. It records only non-secret
source provenance. Invalid manifests, symlinks, and unsupported entries fail
before changing the runtime home. `skills-enabled.json` binds approval to the
package hash, manifest capabilities, version, approver, and approval time.

`add` leaves the package disabled. `enable` records owner approval. `update`
repeats the remembered source, stages and validates the replacement, then
revokes prior approval; a failed update keeps the old package and approval.
`disable` keeps the package but removes approval. `remove` requires disablement
and `--yes`. These operations are local owner actions only. They are not chat
commands or Agent Runtime actions.
