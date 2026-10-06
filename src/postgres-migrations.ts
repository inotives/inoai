/** Explicit compatibility entry point for PostgreSQL migrations. */
import { fileURLToPath } from "node:url";
import { main } from "./persistence/postgres-migrations.js";

export * from "./persistence/postgres-migrations.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    console.error("PostgreSQL migrations failed.");
    process.exitCode = 1;
  });
}
