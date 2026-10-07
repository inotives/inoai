import { fileURLToPath } from "node:url";
import { agentSchemaName, normalizeAgentInstanceId } from "../platform/agent-identity.js";

export type AgentProvisioningInput = {
  agentInstanceId: string;
  agentName: string;
  agentProvider: "codex" | "claude" | "opencode";
  runtimeHome: string;
  ownerUserId: string;
};

export type AgentProvisioningPlan = AgentProvisioningInput & {
  agentInstanceId: string;
  agentSchemaName: string;
};

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function agentProvider(value: string): AgentProvisioningInput["agentProvider"] {
  if (value !== "codex" && value !== "claude" && value !== "opencode") {
    throw new Error("agentProvider must be codex, claude, or opencode");
  }
  return value;
}

export function createProvisioningPlan(inputs: AgentProvisioningInput[]): AgentProvisioningPlan[] {
  const plans = inputs.map((input) => {
    const agentInstanceId = normalizeAgentInstanceId(input.agentInstanceId);
    return {
      ...input,
      agentInstanceId,
      agentName: requiredText(input.agentName, "agentName"),
      agentProvider: agentProvider(input.agentProvider),
      runtimeHome: requiredText(input.runtimeHome, "runtimeHome"),
      ownerUserId: requiredText(input.ownerUserId, "ownerUserId"),
      agentSchemaName: agentSchemaName(agentInstanceId),
    };
  }).sort((left, right) => left.agentInstanceId.localeCompare(right.agentInstanceId, "en"));

  const seenIds = new Set<string>();
  const seenSchemas = new Set<string>();
  for (const plan of plans) {
    if (seenIds.has(plan.agentInstanceId)) throw new Error(`Duplicate Agent Instance ID: ${plan.agentInstanceId}`);
    if (seenSchemas.has(plan.agentSchemaName)) throw new Error(`Duplicate Agent Schema: ${plan.agentSchemaName}`);
    seenIds.add(plan.agentInstanceId);
    seenSchemas.add(plan.agentSchemaName);
  }
  return plans;
}

export function renderProvisioningSql(inputs: AgentProvisioningInput[]): string {
  const plans = createProvisioningPlan(inputs);
  const statements = [
    "BEGIN;",
    "CREATE SCHEMA IF NOT EXISTS inoai_control;",
    ...plans.flatMap((plan) => [
      `CREATE SCHEMA IF NOT EXISTS \"${plan.agentSchemaName}\";`,
      `SELECT inoai_control.provision_agent_schema(${sqlLiteral(plan.agentSchemaName)});`,
      `INSERT INTO inoai_control.agent_instances (agent_instance_id, agent_name, agent_provider, runtime_home, agent_schema_name, owner_user_id) VALUES (${sqlLiteral(plan.agentInstanceId)}, ${sqlLiteral(plan.agentName)}, ${sqlLiteral(plan.agentProvider)}, ${sqlLiteral(plan.runtimeHome)}, ${sqlLiteral(plan.agentSchemaName)}, ${sqlLiteral(plan.ownerUserId)});`,
    ]),
    "COMMIT;",
  ];
  return `${statements.join("\n\n")}\n`;
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error("Usage: npm run postgres:provision -- --agent-instance-id <id> --agent-name <name> --agent-provider <provider> --runtime-home <name> --owner-user-id <id>");
  process.exit(2);
}

export function main(args = process.argv.slice(2)): void {
  const agentInstanceId = argumentValue(args, "--agent-instance-id");
  const agentName = argumentValue(args, "--agent-name");
  const agentProvider = argumentValue(args, "--agent-provider") as AgentProvisioningInput["agentProvider"] | undefined;
  const runtimeHome = argumentValue(args, "--runtime-home");
  const ownerUserId = argumentValue(args, "--owner-user-id");
  if (!agentInstanceId || !agentName || !agentProvider || !runtimeHome || !ownerUserId) usage();
  process.stdout.write(renderProvisioningSql([{ agentInstanceId, agentName, agentProvider, runtimeHome, ownerUserId }]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
