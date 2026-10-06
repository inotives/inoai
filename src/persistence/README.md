# Persistence capability

`operational-store.ts` is the stable asynchronous persistence boundary used by
the running application. Its PostgreSQL implementation is kept beside the
pool, lease, migration, and provisioning infrastructure.

`legacy-database.ts` is the synchronous SQLite implementation retained for the
legacy/UI and compatibility paths. It is not an operational store
implementation and must not gain new runtime consumers. The root-level
`database.ts` and `operational-store.ts` files are explicit compatibility entry
points for existing imports while capability code uses these persistence paths
directly.
