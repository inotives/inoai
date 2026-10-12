# Local Agent Skill Management Phase

## Goal

Let an owner acquire and manage provider-neutral skills in one deployed Agent
Instance's runtime home. Support public skills from `skills.sh` and custom
skills from a local source repository without introducing a shared host
catalog.

## Product boundary

This phase is a local CLI workflow for an existing deployment. It does not add
deployment-wizard controls, SPA controls, Discord commands, chat-turn skill
mutation, or a shared catalog.

The public CLI selects an Agent Instance by name:

```text
inoai skills add <source> --skill <skill-id> --agent <name>
inoai skills list --agent <name>
inoai skills enable <skill-id> --agent <name>
inoai skills disable <skill-id> --agent <name>
inoai skills update <skill-id> --agent <name>
inoai skills remove <skill-id> --agent <name> --yes
```

`--agent robin` resolves to `.inoai-connect-robin` in the deployment folder.
The unnamed default remains `.inoai-connect`. `--connect-dir` remains available
for legacy homes and tests.

## Package layout

The runtime home owns the deployed copy:

```text
<runtime-home>/
└── skills/
    └── <skill-id>/
        ├── SKILL.md
        └── skill.yaml
```

Packages are copied, never symlinked. The runtime home is the only location
used by the Agent Runtime.

## Acquisition sources

Remote acquisition accepts either:

- a `skills.sh` page URL, resolved to its repository and selected skill; or
- the upstream repository plus an explicit `--skill <skill-id>`.

Local acquisition accepts a repository or package directory, for example:

```text
inoai skills add ~/workspaces/anyhow-skills \
  --skill stock-data-ohlcv --agent robin
```

The selected skill is mandatory when a source contains multiple skills. Bulk
installation is out of scope.

Remote acquisition invokes `npx skills add` in a temporary staging directory
with `--yes` and telemetry disabled. It must not leave provider-specific
directories or symlinks in the runtime home.

## Manifest and trust

Every deployed package must contain a valid `skill.yaml`.

When the source has no manifest, inoai generates one in the deployed copy with
all capabilities set to `none`:

```yaml
capabilities:
  filesystem: none
  network: none
  process/command: none
  external_mutation: none
```

The manifest also records non-secret source provenance:

```yaml
source:
  locator: <source-url-or-local-path>
  skill: <skill-id>
  revision: <resolved-revision-or-working-tree>
```

When a source already has a valid manifest, inoai preserves its identity,
version, and capabilities. It adds or updates only the source block. Invalid
or unsupported manifests fail acquisition without changing the runtime home.

Acquisition never enables a package. The owner must review and explicitly
enable it. Approval is bound to the package ID, version, manifest capabilities,
and full content hash in `skills-enabled.json`.

## Lifecycle behavior

- `add` stages a new package and leaves it disabled.
- `enable` records explicit owner approval.
- `disable` removes approval but keeps the package.
- `update` repeats the remembered Skill Source, stages and validates a
  replacement, atomically swaps it into place, and revokes prior approval.
- If update fails, the existing package and approval remain unchanged.
- Generated manifests reset to all-`none` capabilities on update. The owner
  must review and reapply any required capability declaration.
- `remove` requires the package to be disabled and an explicit confirmation,
  then deletes the package and approval record.

Acquisition, update, removal, enablement, and disablement are local owner
operations only. The Agent Runtime and chat turns cannot invoke them.

## Acceptance criteria

- A remote `skills.sh` page can add one selected skill to a named deployment.
- A repository URL plus `--skill` can add one selected skill.
- A local custom repository can add one selected skill without a manifest.
- A valid custom manifest is preserved except for source provenance.
- Missing manifests receive conservative generated defaults.
- Add never enables a skill.
- Update is atomic and revokes approval only after replacement succeeds.
- Failed update leaves the old approved package active.
- A changed package hash is unavailable until reapproved.
- Disable keeps the package; remove deletes it only after explicit confirmation.
- No operation changes global provider configuration or writes outside the
  selected deployment and temporary staging area.
- Existing profile, runtime, and skill-loader behavior remains compatible.
