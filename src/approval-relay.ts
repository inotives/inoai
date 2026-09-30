import type { DatabaseSync } from "node:sqlite";

import type { CodexAppServer } from "./codex-app-server.js";
import { archiveMessage, createEvent, getSession } from "./database.js";
import type { ChatTransport } from "./transport.js";

type Request = { threadId?: string; conversationId?: string };

const notice = "Codex permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local Codex for the blocked action.";

export class ApprovalRelay {
  private readonly removeRequest: () => void;

  constructor(
    private readonly database: DatabaseSync,
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
    const session = this.database.prepare(`SELECT id FROM sessions WHERE agent_provider = 'codex' AND agent_session_id = ?
      AND state = 'active' AND deleted_at IS NULL`).get(threadId) as { id: number } | undefined;
    if (!session) return;
    const bound = getSession(this.database, session.id)!;
    createEvent(this.database, { session_id: session.id, message_id: null, event_type: "approval_unsupported", detail: "declined: no safe action preview" }, "runtime:codex");
    const messageId = await this.transport.sendMessage(bound.conversation_id, notice);
    archiveMessage(this.database, {
      session_id: session.id, transport: bound.transport, workspace_id: bound.workspace_id,
      external_message_id: messageId, external_author_id: null, user_id: null,
      direction: "agent", body: notice, reply_to_external_message_id: null, in_reply_to_message_id: null,
      state: "completed",
    }, "transport:discord");
  }
}
