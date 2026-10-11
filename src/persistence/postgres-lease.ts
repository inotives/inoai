import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { normalizeAgentInstanceId } from "../platform/agent-identity.js";

export type AgentLeaseOptions = {
  agentInstanceId: string;
  ttlMs: number;
  refreshMs: number;
};

export type AgentLease = {
  refresh(): Promise<void>;
  release(): Promise<void>;
};

type Queryable = Pick<Pool, "query">;

const leaseLockPrefix = "inoai.agent_instance_lease:";

/** Read ownership freshness without acquiring or extending the child's lease. */
export async function agentInstanceLeaseFresh(pool: Queryable, agentInstanceId: string): Promise<boolean> {
  const rows = await queryRows<{ fresh: boolean }>(pool, `
    SELECT EXISTS (
      SELECT 1 FROM inoai_control.agent_instance_leases lease
      JOIN inoai_control.agent_instances instance USING (agent_instance_id)
      WHERE lease.agent_instance_id = $1 AND lease.owner_token IS NOT NULL
        AND lease.expires_at > now() AND instance.disabled_at IS NULL
    ) AS fresh`, [normalizeAgentInstanceId(agentInstanceId)]);
  return rows[0]?.fresh === true;
}

function safeError(): Error {
  return new Error("PostgreSQL Agent Instance lease operation failed");
}

function durationLiteral(milliseconds: number): string {
  return `${milliseconds} milliseconds`;
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    const transactionClient = await pool.connect();
    client = transactionClient;
    await transactionClient.query("BEGIN");
    const value = await work(transactionClient);
    await transactionClient.query("COMMIT");
    return value;
  } catch {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw safeError();
  } finally {
    client?.release();
  }
}

async function queryRows<T extends QueryResultRow>(queryable: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  try {
    return (await queryable.query<T>(text, values)).rows;
  } catch {
    throw safeError();
  }
}

/**
 * Coordinates one Agent Instance across machines sharing PostgreSQL.
 * The process still needs the runtime-home inoai.lock for the fast local guard.
 */
export async function acquireAgentInstanceLease(pool: Pool, options: AgentLeaseOptions): Promise<AgentLease> {
  const agentInstanceId = normalizeAgentInstanceId(options.agentInstanceId);
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 || !Number.isSafeInteger(options.refreshMs) || options.refreshMs <= 0 || options.refreshMs >= options.ttlMs) {
    throw new Error("Agent lease TTL and refresh interval are invalid");
  }
  const token = randomUUID();
  const acquired = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${leaseLockPrefix}${agentInstanceId}`]);
    const rows = await queryRows<{ agent_instance_id: string }>(client, `
      INSERT INTO inoai_control.agent_instance_leases AS lease
        (agent_instance_id, owner_token, acquired_at, heartbeat_at, expires_at)
      SELECT $1, $2, now(), now(), now() + $3::interval
      WHERE EXISTS (
        SELECT 1 FROM inoai_control.agent_instances
        WHERE agent_instance_id = $1 AND disabled_at IS NULL
      )
      ON CONFLICT (agent_instance_id) DO UPDATE
        SET owner_token = EXCLUDED.owner_token,
            acquired_at = EXCLUDED.acquired_at,
            heartbeat_at = EXCLUDED.heartbeat_at,
            expires_at = EXCLUDED.expires_at
        WHERE lease.expires_at <= now()
      RETURNING agent_instance_id`, [agentInstanceId, token, durationLiteral(options.ttlMs)]);
    return rows.length === 1;
  });
  if (!acquired) throw new Error("Agent Instance is already active or not provisioned");

  let released = false;
  let refreshing: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    if (released) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const rows = await queryRows<{ agent_instance_id: string }>(pool, `
        UPDATE inoai_control.agent_instance_leases
        SET heartbeat_at = now(), expires_at = now() + $3::interval
        WHERE agent_instance_id = $1 AND owner_token = $2 AND expires_at > now()
        RETURNING agent_instance_id`, [agentInstanceId, token, durationLiteral(options.ttlMs)]);
      if (rows.length !== 1) {
        released = true;
        throw new Error("Agent Instance lease is no longer owned");
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const timer = setInterval(() => { void refresh().catch(() => undefined); }, options.refreshMs);
  timer.unref?.();
  return {
    refresh,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await queryRows(pool, `
        UPDATE inoai_control.agent_instance_leases
        SET owner_token = NULL, heartbeat_at = now(), expires_at = now()
        WHERE agent_instance_id = $1 AND owner_token = $2`, [agentInstanceId, token]);
    },
  };
}
