const agentInstanceIdPattern = /^agent-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const agentSchemaNamePattern = /^agent_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function normalizeAgentInstanceId(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 63 || !agentInstanceIdPattern.test(normalized)) {
    throw new Error("AGENT_INSTANCE_ID must be a lowercase agent- slug of at most 63 characters");
  }
  return normalized;
}

export function agentSchemaName(agentInstanceId: string): string {
  const normalized = normalizeAgentInstanceId(agentInstanceId);
  const schema = normalized.replaceAll("-", "_");
  if (!agentSchemaNamePattern.test(schema) || schema.length > 63) {
    throw new Error("Derived Agent Schema name is not a safe PostgreSQL identifier");
  }
  return schema;
}
