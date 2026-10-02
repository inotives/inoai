import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { AgentRuntime } from "./agent-runtime.js";
import { bindAgentSession, getSession } from "./database.js";
import type { RuntimeHome } from "./runtime-home.js";

export async function startAgentSession(database: DatabaseSync, runtime: AgentRuntime, sessionId: number, home: RuntimeHome): Promise<string> {
  const session = getSession(database, sessionId);
  if (!session || !session.agent_session_id.startsWith("pending:")) throw new Error("Agent Session is not pending");
  const instructions = await readFile(home.agentFile, "utf8");
  const threadId = await runtime.createSession(session.project_path, instructions);
  bindAgentSession(database, sessionId, threadId, `runtime:${session.agent_provider}`);
  return threadId;
}

export async function resumeAgentSession(database: DatabaseSync, runtime: AgentRuntime, sessionId: number, home: RuntimeHome): Promise<string> {
  const session = getSession(database, sessionId);
  if (!session || session.agent_session_id.startsWith("pending:") || session.state !== "active") throw new Error("Agent Session has no runtime session to resume");
  const instructions = await readFile(home.agentFile, "utf8");
  await runtime.resumeSession(session.agent_session_id, session.project_path, instructions);
  return session.agent_session_id;
}
