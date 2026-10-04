import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import { createProvisioningPlan, renderProvisioningSql, type AgentProvisioningInput } from "../postgres-provision.js";
import { runMigrations } from "../postgres-migrations.js";
import { createPostgresPool } from "../postgres.js";
import { acquireAgentInstanceLease } from "../postgres-lease.js";
import { PostgresOperationalStore } from "../operational-store.js";

const adminUrl = process.env.POSTGRES_INTEGRATION_URL?.trim();
const runtimeUrl = process.env.POSTGRES_INTEGRATION_RUNTIME_URL?.trim();
const integrationEnabled = Boolean(adminUrl);

function instanceId(suffix: string): string {
  return `agent-integration-${process.pid}-${Date.now()}-${suffix}`.slice(0, 63);
}

function provisioningInput(id: string, suffix: string): AgentProvisioningInput {
  return {
    agentInstanceId: id,
    agentName: `integration-${suffix}`,
    agentProvider: "codex",
    runtimeHome: `.inoai-connect-integration-${suffix}`,
    ownerUserId: `integration-owner-${suffix}`,
  };
}

test("PostgreSQL Docker acceptance: two Agent Instances, queue, Memory, reviews, leases, and outage", { skip: !integrationEnabled }, async () => {
  assert.ok(runtimeUrl, "POSTGRES_INTEGRATION_RUNTIME_URL is required and must use the restricted inoai_sync role");
  const admin = createPostgresPool({
    postgresUrl: adminUrl!,
    postgresPoolMax: 2,
    postgresConnectTimeoutMs: 5_000,
    postgresIdleTimeoutMs: 5_000,
    postgresQueryTimeoutMs: 30_000,
  });
  const runtime = createPostgresPool({
    postgresUrl: runtimeUrl!,
    postgresPoolMax: 4,
    postgresConnectTimeoutMs: 5_000,
    postgresIdleTimeoutMs: 5_000,
    postgresQueryTimeoutMs: 30_000,
  });
  const idOne = instanceId("one");
  const idTwo = instanceId("two");
  const plans = createProvisioningPlan([provisioningInput(idOne, "one"), provisioningInput(idTwo, "two")]);
  const schemas = plans.map((plan) => `"${plan.agentSchemaName}"`);
  let leaseOne: Awaited<ReturnType<typeof acquireAgentInstanceLease>> | undefined;
  let leaseTwo: Awaited<ReturnType<typeof acquireAgentInstanceLease>> | undefined;
  const stores: PostgresOperationalStore[] = [];
  let runtimeClosed = false;

  try {
    await runMigrations(admin, resolve(process.cwd(), "migrations"));
    const migrationRows = await admin.query<{ version: string }>("SELECT version FROM public.schema_migrations WHERE version = ANY($1::text[]) ORDER BY version", [["0001", "0002", "0003", "0004", "0005"]]);
    assert.deepEqual(migrationRows.rows.map((row) => row.version), ["0001", "0002", "0003", "0004", "0005"]);

    await admin.query(renderProvisioningSql(plans));
    const identity = await runtime.query<{ current_user: string }>("SELECT current_user");
    assert.equal(identity.rows[0]?.current_user, "inoai_sync");
    const registration = await runtime.query<{ agent_instance_id: string; agent_schema_name: string }>(
      "SELECT agent_instance_id, agent_schema_name FROM inoai_control.agent_instances WHERE agent_instance_id = ANY($1::text[]) ORDER BY agent_instance_id",
      [[idOne, idTwo]],
    );
    assert.deepEqual(registration.rows.map((row) => row.agent_instance_id), [idOne, idTwo].sort());
    assert.notEqual(registration.rows[0]?.agent_schema_name, registration.rows[1]?.agent_schema_name);

    const grants = await runtime.query<{ schema_name: string; can_use: boolean }>(
      "SELECT schema_name, has_schema_privilege(current_user, schema_name, 'USAGE') AS can_use FROM unnest($1::text[]) AS schema_names(schema_name) ORDER BY schema_name",
      [plans.map((plan) => plan.agentSchemaName)],
    );
    assert.equal(grants.rows.length, 2);
    assert.ok(grants.rows.every((row) => row.can_use));
    await assert.rejects(
      () => runtime.query(`CREATE TABLE ${schemas[0]}.integration_ddl_probe (id integer)`),
      /permission denied|must be owner|insufficient privilege/i,
    );

    leaseOne = await acquireAgentInstanceLease(runtime, { agentInstanceId: idOne, ttlMs: 10_000, refreshMs: 2_000 });
    await assert.rejects(
      () => acquireAgentInstanceLease(runtime, { agentInstanceId: idOne, ttlMs: 10_000, refreshMs: 2_000 }),
      /already active or not provisioned/,
    );
    leaseTwo = await acquireAgentInstanceLease(runtime, { agentInstanceId: idTwo, ttlMs: 10_000, refreshMs: 2_000 });
    await Promise.all([leaseOne.refresh(), leaseTwo.refresh()]);

    const storeOne = new PostgresOperationalStore(runtime, idOne);
    const storeTwo = new PostgresOperationalStore(runtime, idTwo);
    stores.push(storeOne, storeTwo);
    const userOne = await storeOne.upsertUser({ transport: "discord", workspace_id: "integration", external_user_id: "owner", display_name: "Owner", role: "owner", state: "active" }, "integration");
    const userTwo = await storeTwo.upsertUser({ transport: "discord", workspace_id: "integration", external_user_id: "owner", display_name: "Owner", role: "owner", state: "active" }, "integration");
    assert.ok(userOne && userTwo);
    const sessionOne = await storeOne.createSession({ user_id: userOne.id, transport: "discord", workspace_id: "integration", parent_conversation_id: "thread-one", conversation_id: "thread-one", initiating_external_message_id: "start-one", agent_provider: "codex", agent_session_id: "pending:integration-one", project_path: "/tmp/integration-one" }, "integration");
    const sessionTwo = await storeTwo.createSession({ user_id: userTwo.id, transport: "discord", workspace_id: "integration", parent_conversation_id: "thread-two", conversation_id: "thread-two", initiating_external_message_id: "start-two", agent_provider: "codex", agent_session_id: "pending:integration-two", project_path: "/tmp/integration-two" }, "integration");
    const first = await storeOne.archiveMessage({ session_id: sessionOne.id, transport: "discord", workspace_id: "integration", external_message_id: "same-external-id", external_author_id: "owner", user_id: userOne.id, direction: "user", body: "queue-one", reply_to_external_message_id: null, in_reply_to_message_id: null }, "integration");
    const duplicate = await storeOne.archiveMessage({ session_id: sessionOne.id, transport: "discord", workspace_id: "integration", external_message_id: "same-external-id", external_author_id: "owner", user_id: userOne.id, direction: "user", body: "duplicate", reply_to_external_message_id: null, in_reply_to_message_id: null }, "integration");
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.message?.id, first.message?.id);
    const second = await storeTwo.archiveMessage({ session_id: sessionTwo.id, transport: "discord", workspace_id: "integration", external_message_id: "same-external-id", external_author_id: "owner", user_id: userTwo.id, direction: "user", body: "queue-two", reply_to_external_message_id: null, in_reply_to_message_id: null }, "integration");
    assert.ok(first.message && second.message);
    assert.equal(second.inserted, true);
    assert.notEqual(first.message.body, second.message.body);
    const claimed = await storeOne.claimNextMessage("per-session", "integration");
    assert.equal(claimed?.id, first.message.id);
    await storeOne.markRuntimeStarted(claimed!.id, "integration");
    const reviewBoundary = await storeOne.archiveMessage({ session_id: sessionOne.id, transport: "discord", workspace_id: "integration", external_message_id: "review-boundary", external_author_id: "owner", user_id: userOne.id, direction: "user", body: "review-boundary", reply_to_external_message_id: null, in_reply_to_message_id: null }, "integration");
    assert.ok(reviewBoundary.message);
    const memory = await storeOne.createMemory({ body: "integration memory", source_message_id: claimed!.id, created_by_user_id: userOne.id, review_id: null, origin: "manual" }, "integration");
    assert.deepEqual((await storeOne.listMemories()).map((entry) => entry.id), [memory.id]);
    assert.deepEqual(await storeTwo.listMemories(), []);
    const review = await storeOne.createMemoryReview({ session_id: sessionOne.id, from_message_id: first.message!.id, through_message_id: reviewBoundary.message.id }, "integration");
    assert.equal((await storeOne.completeMemoryReview(review.id, "integration recap", "integration"))?.state, "completed");
    assert.equal((await storeOne.readMemoryReview(sessionOne.id, review.id)).review?.recap, "integration recap");

    await leaseOne.release();
    leaseOne = undefined;
    await leaseTwo.release();
    leaseTwo = undefined;
    const released = await admin.query<{ owner_token: string | null; expires_at: Date }>(
      "SELECT owner_token, expires_at FROM inoai_control.agent_instance_leases WHERE agent_instance_id = ANY($1::text[]) ORDER BY agent_instance_id",
      [[idOne, idTwo]],
    );
    assert.equal(released.rows.length, 2);
    assert.ok(released.rows.every((row) => row.owner_token === null));

    await storeOne.close();
    await storeTwo.close().catch(() => undefined);
    stores.length = 0;
    await assert.rejects(() => runtime.query("SELECT 1"), /ended|closed|Cannot use a pool after calling end/i);
    runtimeClosed = true;

    const unavailable = createPostgresPool({ postgresUrl: "postgresql://127.0.0.1:1/unavailable", postgresPoolMax: 1, postgresConnectTimeoutMs: 250, postgresIdleTimeoutMs: 250, postgresQueryTimeoutMs: 500 });
    try {
      await assert.rejects(() => acquireAgentInstanceLease(unavailable, { agentInstanceId: idOne, ttlMs: 10_000, refreshMs: 2_000 }), /PostgreSQL Agent Instance lease operation failed/);
    } finally {
      await unavailable.end();
    }
  } finally {
    await leaseOne?.release().catch(() => undefined);
    await leaseTwo?.release().catch(() => undefined);
    for (const store of stores) await store.close().catch(() => undefined);
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.query("DELETE FROM inoai_control.agent_instances WHERE agent_instance_id = ANY($1::text[])", [[idOne, idTwo]]).catch(() => undefined);
    await admin.end();
    if (!runtimeClosed) await runtime.end();
  }
});
