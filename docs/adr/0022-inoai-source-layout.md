# ADR 0022: Establish the inoai capability source layout

## Status

Accepted for the full source-structure refactor.

## Context

Earlier capability refactors improved some boundaries but left many
implementation files directly under `src/`. Root-level compatibility shims and
duplicate flat/folder modules made the intended ownership unclear. The UI was
also placed under `platform` even though it is a separate product surface.

## Decision

- Keep `src/index.ts` as the executable entrypoint.
- Put the backend package under `src/inoai/`.
- Put composition and lifecycle code in the thin `src/inoai/app.ts` entry
  module.
- Put each capability directly under `src/inoai/<feature>/`; do not add a
  second `capabilities/` or `core/` nesting layer.
- Treat the deployed Agent Instance as an explicit capability. It owns
  instance identity, profile and configuration validation, runtime-home
  lifecycle, deployment readiness, and ownership-lock policy.
- Put database migrations under `src/inoai/migrations/`.
- Put concrete external-system integrations under `src/inoai/connectors/`.
- Keep the UI as a separate top-level product surface under `src/ui/`.
- Put UI pages and UI-only reusable modules under `src/ui/pages/` and
  `src/ui/common/`.
- Keep the UI API layer separate from page rendering and UI common modules.
  The API owns route handling and UI read-model assembly; it uses read-only
  data access and does not depend on the agent's operational write store.
- Put inoai tests under `src/inoai/test/` and UI tests under `src/ui/test/`.
- Do not keep production implementation files directly under `src/` after the
  refactor, except `src/index.ts`.
- Remove or migrate compatibility shims before declaring the refactor complete.
- Do not create a generic global `common`, `utils`, or `services` bucket.
  Shared code must have an identified owner; UI-only sharing stays in
  `src/ui/common/`.

## Consequences

Ownership becomes visible from the path, and the backend and UI have a clear
dependency direction. The refactor will require import-path changes and a
deliberate migration of tests and compatibility exports. Existing ADR 0016 and
ADR 0017 remain useful for capability and application-layer principles, but
their temporary root-shim allowance is superseded by this decision.

## Target shape

```text
src/
  index.ts
  inoai/
    app.ts
    agent-instance/
    conversation/
    memory/
    heartbeat/
    skills/
    agent-runtime/
    transport/
    persistence/
    migrations/
    connectors/
    test/
  ui/
    pages/
    common/
    api/
    test/
```
