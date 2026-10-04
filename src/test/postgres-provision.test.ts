import assert from "node:assert/strict";
import test from "node:test";

import { agentSchemaName } from "../agent-identity.js";
import { createProvisioningPlan, renderProvisioningSql, type AgentProvisioningInput } from "../postgres-provision.js";

const planner: AgentProvisioningInput = {
  agentInstanceId: "agent-inoai-planner",
  agentName: ".inoai-connect-planner",
  agentProvider: "codex",
  runtimeHome: ".inoai-connect-planner",
  ownerUserId: "owner-123",
};

test("derives a safe schema name from the planner Agent Instance", () => {
  assert.equal(agentSchemaName(planner.agentInstanceId), "agent_inoai_planner");
});

test("renders deterministic sorted SQL for the planner and a future agent", () => {
  const future = { ...planner, agentInstanceId: "agent-ai-coder", agentName: "AI Coder", runtimeHome: ".inoai-connect-coder" };
  const first = renderProvisioningSql([planner, future]);
  const second = renderProvisioningSql([future, planner]);
  assert.equal(first, second);
  assert.match(first, /CREATE SCHEMA IF NOT EXISTS "agent_ai_coder"/);
  assert.match(first, /provision_agent_schema\('agent_ai_coder'\)/);
  assert.match(first, /agent_inoai_planner/);
  assert.doesNotMatch(first, /postgres|password|secret|token/i);
});

test("rejects duplicates and unsafe identifiers before generating SQL", () => {
  assert.throws(() => createProvisioningPlan([planner, planner]), /Duplicate Agent Instance ID/);
  assert.throws(() => agentSchemaName("agent-unsafe_value"), /lowercase agent-/);
  assert.throws(() => renderProvisioningSql([{ ...planner, agentName: "   " }]), /agentName is required/);
  assert.throws(() => renderProvisioningSql([{ ...planner, agentProvider: "invalid" as AgentProvisioningInput["agentProvider"] }]), /agentProvider must be/);
});
