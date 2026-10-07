# Platform adapters

This directory owns process- and deployment-specific concerns that are shared
by the application composition root and capability adapters:

- `config.ts` loads and validates a runtime home's configuration.
- `runtime-home.ts` bootstraps homes and owns the local process lock.
- `agent-identity.ts` validates instance identifiers and derives schema names.
- `ui.ts` launches the sibling local UI bundle.

The root-level modules remain compatibility re-exports during the feature
structure refactor. New production code should import platform concerns from
this directory directly.
