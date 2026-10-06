# ADR 0017: Add an application layer over capability modules

## Status

Accepted for the feature-based structure refactor.

## Context

The codebase already uses capability modules such as Conversation, Memory,
Persistence, Runtime, and Transport. The next phase must make that structure
scale toward future capabilities such as Tasks, Knowledge, Agent Accounts, and
Trading while preserving current behavior. A future UI will operate through
the same application behavior and PostgreSQL operational database, but UI/API
implementation is deferred.

## Decision

- Keep the existing capability modules as the foundation; do not replace them
  with a second feature taxonomy or add empty placeholder capabilities.
- Keep `app/` as the composition root and process bootstrap. Add a distinct
  `application/` layer for capability-aligned use cases and ports.
- Organize application use cases by capability rather than creating a flat
  service or utility bucket.
- Keep infrastructure adapters in named boundaries (`platform`, `persistence`,
  `runtime`, and `transport`). Adapters implement ports owned by the
  application capability that needs them.
- Move configuration, runtime-home lifecycle, instance identity, and local
  launch concerns into `platform/`.
- Keep `Memory` and future `Knowledge` as separate boundaries. Memory is
  agent-maintained facts and review output; Knowledge is external/shared
  retrieval with indexing and provenance.
- Treat `Agent Instance` and future `Agent Account` as separate concepts. An
  instance owns role, archive, and operational state; an account represents an
  external runtime or service identity.
- Colocate focused unit tests with their capability and keep cross-capability
  integration/acceptance tests in a top-level test area.
- Do not add generic `common/`, `utils/`, `services/`, or broad barrel-export
  buckets. Keep ports explicit and capability-owned.
- Retain root-level compatibility shims during this phase. Remove them only in
  a dedicated cleanup phase after consumers migrate.
- Execute the refactor incrementally by capability slice, preserving the
  existing CLI, Discord, provider, persistence, and Memory Review behavior at
  every slice.

## Consequences

The application layer can later serve Discord, a local UI service, and other
adapters without duplicating business rules or exposing PostgreSQL credentials
to the UI. Capability ownership remains visible as the system grows. The
trade-off is additional explicit ports and a later cleanup phase for the
compatibility shims.

## Deferred

Tasks, scheduling, Knowledge implementation, Agent Accounts, Trading, and the
UI/API transport are future capabilities. This phase creates structure and
ports only where needed to preserve current behavior; it does not implement
those features.
