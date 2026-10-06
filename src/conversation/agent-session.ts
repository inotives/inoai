import { readFile } from "node:fs/promises";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { RuntimeHome } from "../runtime-home.js";

export async function startAgentSession(database: Pick<OperationalStore, "getSession" | "bindAgentSession">, runtime: AgentRuntime, sessionId: number, home: RuntimeHome): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || !session.agent_session_id.startsWith("pending:")) throw new Error("Agent Session is not pending");
  const instructions = await readFile(home.agentFile, "utf8");
  const threadId = await runtime.createSession(session.project_path, instructions);
  await database.bindAgentSession(sessionId, threadId, `runtime:${session.agent_provider}`);
  return threadId;
}

export async function resumeAgentSession(database: Pick<OperationalStore, "getSession">, runtime: AgentRuntime, sessionId: number, home: RuntimeHome): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || session.agent_session_id.startsWith("pending:") || session.state !== "active") throw new Error("Agent Session has no runtime session to resume");
  const instructions = await readFile(home.agentFile, "utf8");
  await runtime.resumeSession(session.agent_session_id, session.project_path, instructions);
  return session.agent_session_id;
}
