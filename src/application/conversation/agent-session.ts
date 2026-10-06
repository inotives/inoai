import { readFile } from "node:fs/promises";

import type { AgentSessionHome, AgentSessionRuntime, AgentSessionStore } from "./ports.js";

export async function startAgentSession(
  database: AgentSessionStore,
  runtime: Pick<AgentSessionRuntime, "createSession">,
  sessionId: number,
  home: AgentSessionHome,
): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || !session.agent_session_id.startsWith("pending:")) throw new Error("Agent Session is not pending");
  const instructions = await readFile(home.agentFile, "utf8");
  const threadId = await runtime.createSession(session.project_path, instructions);
  await database.bindAgentSession(sessionId, threadId, `runtime:${session.agent_provider}`);
  return threadId;
}

export async function resumeAgentSession(
  database: Pick<AgentSessionStore, "getSession">,
  runtime: Pick<AgentSessionRuntime, "resumeSession">,
  sessionId: number,
  home: AgentSessionHome,
): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || session.agent_session_id.startsWith("pending:") || session.state !== "active") {
    throw new Error("Agent Session has no runtime session to resume");
  }
  const instructions = await readFile(home.agentFile, "utf8");
  await runtime.resumeSession(session.agent_session_id, session.project_path, instructions);
  return session.agent_session_id;
}
