# Feature-based structure refactor plan

## Goal

Improve the maintainability and scalability of the current TypeScript layout
without changing application behavior. Preserve the existing capability
boundaries and add an application layer that can later serve Discord and a
local UI service over the shared PostgreSQL operational database.

## Invariants

- No CLI, Discord, provider, persistence, lock/lease, security, or Memory
  Review behavior changes.
- PostgreSQL remains the operational source of truth.
- No UI/API implementation, Tasks, Scheduling, Knowledge retrieval, Agent
  Accounts, or Trading feature is implemented in this phase.
- Root compatibility shims remain until a later cleanup phase.
- Existing tests and public entry points remain usable throughout the work.

## Target structure

```text
src/
├── app/                 # composition root and process bootstrap
├── application/         # capability-aligned use cases and owned ports
│   ├── conversation/
│   ├── memory/
│   └── ...              # future capabilities add their own slice
├── conversation/        # conversation domain/orchestration
├── memory/              # reviewed agent Memory
├── persistence/         # PostgreSQL operational and legacy/UI persistence adapters
├── platform/            # config, runtime home, identity, local launch concerns
├── runtime/             # provider adapters
├── transport/           # Discord and future transport adapters
└── test/                # cross-capability integration and acceptance tests
```

Focused unit tests move beside the capability they exercise. Root-level module
names remain as thin compatibility entry points until the cleanup phase.

## Dependency rule

The composition root wires concrete adapters. Application use cases depend on
ports owned by their capability. Platform, persistence, runtime, transport,
and future UI adapters implement those ports. Capability modules do not import
Discord, PostgreSQL, provider SDK details, or Electron directly.

## Implementation slices

1. Establish `application/` conventions and extract the first
   behavior-preserving use-case/port boundary.
2. Move platform concerns out of the root and keep `app/` as composition only.
3. Align Conversation and Memory orchestration with application use cases.
4. Align Persistence, Runtime, and Transport adapters with owned ports.
5. Colocate focused tests and leave integration tests in the top-level test
   area.
6. Run integrated architecture and behavior verification.

Each slice requires focused tests, the full test suite, typecheck, build, and
diff checks. No slice commits or pushes until explicitly requested.

## Follow-up phase

After all consumers use the new paths, run a separate cleanup phase to remove
the root compatibility shims and finalize the public module surface.
