import type { CodexAppServer } from "../runtime/codex-app-server.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { ChatTransport } from "./discord.js";

type Request = { threadId?: string; conversationId?: string };

export function permissionDeclinedNotice(name: string): string {
  return `${name} permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local ${name} for the blocked action.`;
}

export const legacyApprovalNotice = "A saved Codex approval could not be resumed after restart. No action was approved. Please make a fresh request.";

const notice = permissionDeclinedNotice("Codex");

export class ApprovalRelay {
  private readonly removeRequest: () => void;

  constructor(
    private readonly database: OperationalStore,
    private readonly server: CodexAppServer,
    private readonly transport: ChatTransport,
  ) {
    this.removeRequest = server.addRequestListener((method, params, id) => {
      const request = params as Request | null;
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        void this.decline(id, request?.threadId, { decision: "decline" }).catch(() => {});
      } else if (method === "item/permissions/requestApproval") {
        void this.decline(id, request?.threadId, { permissions: {}, scope: "turn" }).catch(() => {});
      } else if (method === "applyPatchApproval" || method === "execCommandApproval") {
        void this.decline(id, request?.conversationId, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }).catch(() => {});
      }
    });
  }

  close(): void { this.removeRequest(); }

  private async decline(requestId: number | string, threadId: string | undefined, response: unknown): Promise<void> {
    try { this.server.respond(requestId, response); } catch { return; }
    if (typeof threadId !== "string") return;
    const session = await this.database.findSessionByAgentSession("codex", threadId);
    if (!session) return;
    const bound = await this.database.getSession(session.id);
    if (!bound) return;
    await this.database.createEvent({ session_id: session.id, message_id: null, event_type: "approval_unsupported", detail: "declined: no safe action preview" }, "runtime:codex");
    const messageId = await this.transport.sendMessage(bound.conversation_id, notice);
    await this.database.archiveMessage({
      session_id: session.id, transport: bound.transport, workspace_id: bound.workspace_id,
      external_message_id: messageId, external_author_id: null, user_id: null,
      direction: "agent", body: notice, reply_to_external_message_id: null, in_reply_to_message_id: null,
      state: "completed",
    }, "transport:discord");
  }
}

// The headless Claude and OpenCode CLIs deny prompts themselves; this only reports each denied Turn once.
// It receives a count, never tool names or input, so nothing raw can reach SQLite or Discord.
function permissionDenialNotifier(database: OperationalStore, transport: ChatTransport, provider: "claude" | "opencode", name: string): (agentSessionId: string, count: number) => void {
  const notice = permissionDeclinedNotice(name);
  return (agentSessionId, count) => {
    void (async () => {
      const session = await database.findSessionByAgentSession(provider, agentSessionId);
      if (!session) return;
      const bound = await database.getSession(session.id);
      if (!bound) return;
      await database.createEvent({ session_id: session.id, message_id: null, event_type: "approval_unsupported", detail: `declined: no safe action preview; denials=${count}` }, `runtime:${provider}`);
      const messageId = await transport.sendMessage(bound.conversation_id, notice);
      await database.archiveMessage({
        session_id: session.id, transport: bound.transport, workspace_id: bound.workspace_id,
        external_message_id: messageId, external_author_id: null, user_id: null,
        direction: "agent", body: notice, reply_to_external_message_id: null, in_reply_to_message_id: null,
        state: "completed",
      }, "transport:discord");
    })().catch(() => {});
  };
}

export function claudePermissionDenialNotifier(database: OperationalStore, transport: ChatTransport): (agentSessionId: string, count: number) => void {
  return permissionDenialNotifier(database, transport, "claude", "Claude");
}

export function openCodePermissionDenialNotifier(database: OperationalStore, transport: ChatTransport): (agentSessionId: string, count: number) => void {
  return permissionDenialNotifier(database, transport, "opencode", "OpenCode");
}
