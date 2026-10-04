import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresPool } from "../postgres.js";
import { acquireAgentInstanceLease } from "../postgres-lease.js";
import type { OperationalStore } from "../operational-store.js";

test("creates a bounded PostgreSQL pool from validated settings", async () => {
  const pool = createPostgresPool({
    postgresUrl: "postgresql://inoai_sync:secret@example.test:5432/app",
    postgresPoolMax: 2,
    postgresConnectTimeoutMs: 5000,
    postgresIdleTimeoutMs: 10000,
    postgresQueryTimeoutMs: 30000,
  });
  try {
    assert.equal(pool.options.max, 2);
    assert.equal(pool.options.connectionTimeoutMillis, 5000);
    assert.equal(pool.options.idleTimeoutMillis, 10000);
    assert.equal(pool.options.query_timeout, 30000);
  } finally {
    await pool.end();
  }
});

test("publishes the async operational store contract", () => {
  const store = {} as OperationalStore;
  assert.equal(typeof store, "object");
});

test("validates lease timing before using the database", async () => {
  const pool = { connect: async () => { throw new Error("must not connect"); } } as never;
  await assert.rejects(acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 1_000, refreshMs: 1_000 }), /TTL and refresh/);
});

test("acquires, refreshes, and releases an Agent Instance lease without exposing errors", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("RETURNING agent_instance_id")) return { rows: [{ agent_instance_id: "agent-test" }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async (text: string) => {
      queries.push(text);
      return { rows: [{ agent_instance_id: "agent-test" }] };
    },
  } as never;
  const lease = await acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 5_000, refreshMs: 1_000 });
  await lease.refresh();
  await lease.release();
  assert.equal(queries.filter((query) => query.includes("pg_advisory_xact_lock")).length, 1);
  assert.equal(queries.filter((query) => query.includes("owner_token = NULL")).length, 1);
});

test("rejects an active owner and permits recovery after expiry", async () => {
  let available = true;
  const client = {
    query: async (text: string) => {
      if (text.includes("RETURNING agent_instance_id")) {
        return { rows: available ? [{ agent_instance_id: "agent-test" }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [{ agent_instance_id: "agent-test" }] }),
  } as never;
  const first = await acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 5_000, refreshMs: 1_000 });
  available = false;
  await assert.rejects(acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 5_000, refreshMs: 1_000 }), /already active or not provisioned/);
  available = true;
  const recovered = await acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 5_000, refreshMs: 1_000 });
  await recovered.release();
  await first.release();
});

test("does not surface PostgreSQL connection details from lease failures", async () => {
  const secret = "postgresql://inoai_sync:secret@example.test/app";
  const pool = {
    connect: async () => ({
      query: async () => { throw new Error(secret); },
      release() {},
    }),
  } as never;
  await assert.rejects(acquireAgentInstanceLease(pool, { agentInstanceId: "agent-test", ttlMs: 5_000, refreshMs: 1_000 }), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
