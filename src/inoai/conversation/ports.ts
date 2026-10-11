/**
 * The smallest persistence port needed by conversation admission policy.
 * Persistence adapters can return richer records; the application only owns
 * and depends on these fields.
 */
export interface ConversationStore {
  findUser(transport: string, workspaceId: string, externalUserId: string): Promise<ConversationUser | undefined>;
  findSessionByConversation(
    transport: string,
    workspaceId: string,
    parentConversationId: string,
    conversationId: string,
  ): Promise<ConversationSession | undefined>;
}

/** The persistence operations needed to bind a runtime session to a conversation. */
export interface AgentSessionStore {
  getSession(sessionId: number): Promise<AgentSessionRecord | undefined>;
  bindAgentSession(sessionId: number, agentSessionId: string, actor: string): Promise<unknown>;
}

/** The runtime operations needed by the conversation session use case. */
export interface AgentSessionRuntime {
  createSession(projectPath: string, instructions: string): Promise<string>;
  resumeSession(agentSessionId: string, projectPath: string, instructions: string): Promise<void>;
}

export interface AgentSessionHome {
  agentFile: string;
  skillsDirectory?: string;
  skillsEnabledFile?: string;
}

export type AgentSessionRecord = {
  agent_session_id: string;
  project_path: string;
  agent_provider: string;
  state: "active" | "ended" | string;
};

export type ConversationUser = { id: number };

export type ConversationSession = {
  id: number;
  state: "active" | "ended" | string;
  updated_by: string;
  user_id: number;
};

export type IncomingConversationMessage = {
  transport: string;
  workspaceId: string | null;
  conversationId: string;
  parentConversationId: string | null;
  externalUserId: string;
  mentionedBotUserIds: string[];
  botUserId: string | null;
  authorIsBot: boolean;
};

export type ConversationPolicyConfiguration = {
  chatProvider: string;
  discordGuildId: string;
  discordStatusChannelId: string;
};
