import type { AgentSessionHome, AgentSessionRuntime, AgentSessionStore } from "./ports.js";
import { loadAgentProfile } from "../agent-instance/profile.js";
import { loadAgentProfileWithSkills, renderEnabledSkillsProfile, type SkillHome } from "../skills/skill-loader.js";

async function loadProfileInstructions(home: AgentSessionHome): Promise<string> {
  if (home.skillsDirectory && home.skillsEnabledFile) return loadAgentProfileWithSkills(home as SkillHome);
  return renderEnabledSkillsProfile(await loadAgentProfile(home.agentFile), { version: 1, skills: [] });
}

// Order: agent.md, inoai Safety, Enabled Skills (when any), then the role block. No block: profile instructions only.
async function loadInstructions(home: AgentSessionHome, roleBlock?: string): Promise<string> {
  const profile = await loadProfileInstructions(home);
  return roleBlock ? `${profile.replace(/\n*$/, "\n")}\n${roleBlock}` : profile;
}

export async function startAgentSession(
  database: AgentSessionStore,
  runtime: Pick<AgentSessionRuntime, "createSession">,
  sessionId: number,
  home: AgentSessionHome,
  roleBlock?: string,
): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || !session.agent_session_id.startsWith("pending:")) throw new Error("Agent Session is not pending");
  const instructions = await loadInstructions(home, roleBlock);
  const threadId = await runtime.createSession(session.project_path, instructions);
  await database.bindAgentSession(sessionId, threadId, `runtime:${session.agent_provider}`);
  return threadId;
}

export async function resumeAgentSession(
  database: Pick<AgentSessionStore, "getSession">,
  runtime: Pick<AgentSessionRuntime, "resumeSession">,
  sessionId: number,
  home: AgentSessionHome,
  roleBlock?: string,
): Promise<string> {
  const session = await database.getSession(sessionId);
  if (!session || session.agent_session_id.startsWith("pending:") || session.state !== "active") {
    throw new Error("Agent Session has no runtime session to resume");
  }
  const instructions = await loadInstructions(home, roleBlock);
  await runtime.resumeSession(session.agent_session_id, session.project_path, instructions);
  return session.agent_session_id;
}
