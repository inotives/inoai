import { Pool } from "pg";

import type { Configuration } from "./config.js";

export type PostgresPoolOptions = {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  query_timeout: number;
};

export function createPostgresPool(configuration: Pick<Configuration, "postgresUrl" | "postgresPoolMax" | "postgresConnectTimeoutMs" | "postgresIdleTimeoutMs" | "postgresQueryTimeoutMs">): Pool {
  return new Pool({
    connectionString: configuration.postgresUrl,
    max: configuration.postgresPoolMax,
    connectionTimeoutMillis: configuration.postgresConnectTimeoutMs,
    idleTimeoutMillis: configuration.postgresIdleTimeoutMs,
    query_timeout: configuration.postgresQueryTimeoutMs,
  });
}
