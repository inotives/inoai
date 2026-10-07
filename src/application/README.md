# Application layer

The application layer owns capability-level use cases and the narrow ports
those use cases need. Each capability gets its own directory, for example
`application/conversation/` and `application/memory/`.

Keep adapters in `platform/`, `persistence/`, `runtime/`, or `transport/`.
They may implement application ports, but application code must not import
adapter implementations or third-party SDKs. Keep entry points explicit; do
not add a catch-all `common/`, `utils/`, `services/`, or barrel-export module.

This layer is intentionally incremental. Existing root modules remain
compatibility entry points until the cleanup phase, and each extracted use
case must preserve the existing public behavior.
