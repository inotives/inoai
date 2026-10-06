/** Explicit compatibility entry point for PostgreSQL provisioning. */
import { fileURLToPath } from "node:url";
import { main } from "./persistence/postgres-provision.js";

export * from "./persistence/postgres-provision.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
