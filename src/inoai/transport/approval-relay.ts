import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { CodexAppServer } from "../connectors/agent-runtime/codex-app-server.js";
import { secretLike } from "../conversation/prompt-context.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { ButtonClick, ChatTransport } from "./ports.js";

type Request = { threadId?: string; conversationId?: string };
type PendingCommand = {
  token: string;
  approvalId: number;
  requestId: number | string;
  threadId: string;
  turnId: string;
  itemId: string;
  sessionId: number;
  workspaceId: string;
  conversationId: string;
  cardMessageId?: string;
  ready: boolean;
  expiresAt: number;
  resolving: boolean;
  finishing: boolean;
  timer: NodeJS.Timeout;
};

const approvalLifetimeMs = 15 * 60_000;
const cardPattern = /^inoai:approval:([0-9a-f-]{36}):(approve|reject)$/;
const safeKeys = new Set([
  "kind", "threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason",
  "command", "cwd", "commandActions", "networkApprovalContext", "additionalPermissions",
  "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions",
]);

function commandPreview(params: unknown): { threadId: string; turnId: string; itemId: string; text: string } | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const request = params as Record<string, unknown>;
  if (Object.keys(request).some((key) => !safeKeys.has(key))) return;
  const { threadId, turnId, itemId, command, cwd, availableDecisions } = request;
  if (request.kind !== undefined && request.kind !== "command") return;
  if (request.startedAtMs !== undefined && (typeof request.startedAtMs !== "number" || !Number.isFinite(request.startedAtMs))) return;
  if (request.approvalId != null || request.environmentId != null || request.networkApprovalContext != null
    || request.additionalPermissions != null || request.proposedExecpolicyAmendment != null
    || request.proposedNetworkPolicyAmendments != null) return;
  if (request.reason != null && (typeof request.reason !== "string" || /\b(network|internet|host|domain)\b/i.test(request.reason))) return;
  if (request.commandActions != null && !Array.isArray(request.commandActions)) return;
  if ([threadId, turnId, itemId, command, cwd].some((value) => typeof value !== "string" || !value.length)) return;
  if (availableDecisions != null && (!Array.isArray(availableDecisions)
    || !availableDecisions.includes("accept") || !availableDecisions.includes("decline"))) return;
  const exactCommand = command as string;
  const exactCwd = cwd as string;
  // A fenced preview is only safe when its contents cannot change Discord's rendering.
  if (!isAbsolute(exactCwd) || [exactCommand, exactCwd].some((value) =>
    /[`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || secretLike.test(value)
    || /\bsk-[\w-]{8,}\b/i.test(value)
    || /(?:--?[\w-]*(?:token|secret|password|api[_-]?key|authorization))\s+\S+/i.test(value)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+@/i.test(value)
    || /(?:^|\s)(?:-u(?:\s+|=)?|--user(?:\s+|=))\S*:\S*/i.test(value))) return;
  const text = `Codex requests approval to run this command once.\n\nCommand:\n\`\`\`text\n${exactCommand}\n\`\`\`\nWorking directory:\n\`\`\`text\n${exactCwd}\n\`\`\`\n\nApprove this request only? Expires in 15 minutes.`;
  if (text.length > 1900) return;
  return { threadId: threadId as string, turnId: turnId as string, itemId: itemId as string, text };
}

export function permissionDeclinedNotice(name: string): string {
  return `${name} permission request declined: this version cannot show a safe, complete action preview in Discord. No action was approved. Use local ${name} for the blocked action.`;
}

// Posted instead of the declined notice when the Turn still answered. Fixed text: no count or tool names.
export function permissionSkippedNotice(name: string): string {
  const hint = name === "Claude" ? " To allow a tool, add it to CLAUDE_ALLOWED_TOOLS in this runtime home's .env." : "";
  return `${name} skipped some tool calls that need approval and answered without them.${hint}`;
}

export const legacyApprovalNotice = "A saved Codex approval could not be resumed after restart. This card cannot approve a command. Please make a fresh request.";

const notice = permissionDeclinedNotice("Codex");

export class ApprovalRelay {
  private readonly removeRequest: () => void;
  private readonly removeNotification: () => void;
  private readonly pending = new Map<string, PendingCommand>();

  constructor(
    private readonly database: OperationalStore,
    private readonly server: CodexAppServer,
    private readonly transport: ChatTransport,
    private readonly owner: { workspaceId: string; externalUserId: string },
    private readonly now: () => number = Date.now,
  ) {
    this.removeRequest = server.addRequestListener((method, params, id) => {
      const request = params as Request | null;
      if (method === "item/commandExecution/requestApproval") {
        void this.offer(id, params).catch(() => this.decline(id, request?.threadId, { decision: "decline" }).catch(() => {}));
      } else if (method === "item/fileChange/requestApproval") {
        void this.decline(id, request?.threadId, { decision: "decline" }).catch(() => {});
      } else if (method === "item/permissions/requestApproval") {
        void this.decline(id, request?.threadId, { permissions: {}, scope: "turn" }).catch(() => {});
      } else if (method === "applyPatchApproval" || method === "execCommandApproval") {
        void this.decline(id, request?.conversationId, { decision: { denied: { rejection: "Approval unavailable via Discord" } } }).catch(() => {});
      } else if (/approval/i.test(method)) {
        void this.decline(id, request?.threadId, { decision: "decline" }).catch(() => {});
      }
    });
    this.removeNotification = server.addNotificationListener((method, params) => {
      if (!params || typeof params !== "object") return;
      if (method === "serverRequest/resolved" && "requestId" in params) {
        const pending = [...this.pending.values()].find((item) => item.requestId === params.requestId);
        if (pending) void this.finish(pending, "failed").catch(() => {});
      } else if (method === "turn/completed" || method === "item/completed") {
        const notice = params as { threadId?: unknown; turnId?: unknown; item?: { id?: unknown } };
        for (const pending of this.pending.values()) {
          if (pending.threadId === notice.threadId && pending.turnId === notice.turnId
            && (method === "turn/completed" || pending.itemId === notice.item?.id)) {
            void this.finish(pending, "failed").catch(() => {});
          }
        }
      }
    });
  }

  close(): void {
    this.removeRequest();
    this.removeNotification();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  async handleClick(click: ButtonClick): Promise<void> {
    const match = cardPattern.exec(click.customId);
    if (!match) { await click.replyEphemeral("Approval card unavailable."); return; }
    const pending = this.pending.get(match[1]!);
    if (!pending || pending.resolving) { await click.replyEphemeral("This approval request is no longer available."); return; }
    if (click.workspaceId !== this.owner.workspaceId || click.externalUserId !== this.owner.externalUserId
      || click.workspaceId !== pending.workspaceId || click.conversationId !== pending.conversationId
      || click.messageId !== pending.cardMessageId) {
      await click.replyEphemeral("Only the owner can use this approval card in its original conversation.");
      return;
    }
    if (!pending.ready) { await click.replyEphemeral("This approval card is still being prepared. Try again shortly."); return; }
    pending.resolving = true;
    try {
      const session = await this.database.getSession(pending.sessionId);
      const owner = await this.database.findUser("discord", pending.workspaceId, this.owner.externalUserId);
      if (!session || !owner || owner.role !== "owner" || session.user_id !== owner.id
        || session.state !== "active" || session.agent_provider !== "codex"
        || session.agent_session_id !== pending.threadId || session.workspace_id !== pending.workspaceId
        || session.conversation_id !== pending.conversationId || !this.server.hasRequest(pending.requestId)) {
        await this.finish(pending, "failed", click);
      } else if (this.now() >= pending.expiresAt) {
        await this.finish(pending, "expired", click);
      } else {
        await this.finish(pending, match[2] === "approve" ? "approved" : "rejected", click);
      }
    } catch {
      await this.finish(pending, "failed", click).catch(() => click.replyEphemeral("Approval failed. No action was approved."));
    }
  }

  private async offer(requestId: number | string, params: unknown): Promise<void> {
    const preview = commandPreview(params);
    const threadId = params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string" ? params.threadId : undefined;
    if (!preview || !this.database.createCommandApproval || !this.database.setCommandApprovalCard
      || !this.database.resolveCommandApproval || !this.transport.sendMessageWithButtons) {
      await this.decline(requestId, threadId, { decision: "decline" });
      return;
    }
    const session = await this.database.findSessionByAgentSession("codex", preview.threadId);
    const bound = session && await this.database.getSession(session.id);
    const owner = await this.database.findUser("discord", this.owner.workspaceId, this.owner.externalUserId);
    if (!bound || !owner || owner.role !== "owner" || bound.user_id !== owner.id
      || bound.state !== "active" || bound.workspace_id !== this.owner.workspaceId
      || bound.agent_session_id !== preview.threadId || !this.server.hasRequest(requestId)) {
      await this.decline(requestId, preview.threadId, { decision: "decline" });
      return;
    }
    const token = randomUUID();
    const expiresAt = this.now() + approvalLifetimeMs;
    const approval = await this.database.createCommandApproval(bound.id, token, Math.ceil(expiresAt / 1000));
    const pending: PendingCommand = {
      token, approvalId: approval.id, requestId, threadId: preview.threadId, turnId: preview.turnId,
      itemId: preview.itemId, sessionId: bound.id, workspaceId: bound.workspace_id!,
      conversationId: bound.conversation_id, expiresAt, ready: false, resolving: false, finishing: false,
      timer: setTimeout(() => { void this.finish(pending, "expired").catch(() => {}); }, approvalLifetimeMs),
    };
    pending.timer.unref();
    this.pending.set(token, pending);
    try {
      const cardMessageId = await this.transport.sendMessageWithButtons(bound.conversation_id, preview.text, [
        { label: "Approve", customId: `inoai:approval:${token}:approve`, style: "success" },
        { label: "Reject", customId: `inoai:approval:${token}:reject`, style: "danger" },
      ]);
      pending.cardMessageId = cardMessageId;
      if (!this.pending.has(token)) {
        await this.transport.editMessage?.(bound.conversation_id, cardMessageId, "Codex command approval is no longer available. No action was approved.");
        return;
      }
      const archived = await this.database.archiveMessage({
        session_id: bound.id, transport: bound.transport, workspace_id: bound.workspace_id,
        external_message_id: cardMessageId, external_author_id: null, user_id: null,
        direction: "agent", body: "Codex command approval card", reply_to_external_message_id: null,
        in_reply_to_message_id: null, state: "completed",
      }, "transport:discord");
      const linked = archived.message && await this.database.setCommandApprovalCard(approval.id, archived.message.id);
      if (!this.pending.has(token)) {
        await this.transport.editMessage?.(bound.conversation_id, cardMessageId, "Codex command approval is no longer available. No action was approved.");
      } else if (!linked || !this.server.hasRequest(requestId)) await this.finish(pending, "failed");
      else pending.ready = true;
    } catch {
      await this.finish(pending, "failed");
    }
  }

  private async finish(pending: PendingCommand, state: "approved" | "rejected" | "expired" | "failed", click?: ButtonClick): Promise<void> {
    if (!this.pending.has(pending.token) || pending.finishing) return;
    pending.finishing = true;
    pending.resolving = true;
    clearTimeout(pending.timer);
    let outcome = state;
    let auditSaved = false;
    if (state === "approved") {
      // A missing audit must never authorize execution. The decision row is committed by SQLite before accept is sent.
      try { auditSaved = await this.database.resolveCommandApproval?.(pending.approvalId, "approved") ?? false; }
      catch { /* Decline the live request below. */ }
      if (!auditSaved) outcome = "failed";
    }
    let protocolUncertain = false;
    if (this.server.hasRequest(pending.requestId)) {
      try { this.server.respond(pending.requestId, { decision: state === "approved" && auditSaved ? "accept" : "decline" }); }
      catch { outcome = "failed"; protocolUncertain = state === "approved" && auditSaved; }
    } else { outcome = "failed"; protocolUncertain = state === "approved" && auditSaved; }
    this.pending.delete(pending.token);
    if (protocolUncertain) {
      await this.database.createEvent({ session_id: pending.sessionId, message_id: null,
        event_type: "approval_response_uncertain", detail: "recorded owner decision; Codex response may not have arrived" }, "runtime:codex").catch(() => {});
    }
    if (state !== "approved" || !auditSaved) {
      try { auditSaved = await this.database.resolveCommandApproval?.(pending.approvalId, outcome) ?? false; }
      catch { /* Report the audit failure on the card. */ }
    }
    const result = protocolUncertain ? "Codex approval response is uncertain. Check the local result before making a fresh request."
      : outcome === "approved" ? "Codex command approved for this request."
      : outcome === "rejected" ? "Codex command rejected."
      : outcome === "expired" ? "Codex command approval expired. No action was approved."
      : "Codex command approval is no longer available. No action was approved.";
    const text = auditSaved ? result : `${result} Local approval audit could not be saved.`;
    if (click) await click.updateMessage(text);
    else if (pending.cardMessageId) await this.transport.editMessage?.(pending.conversationId, pending.cardMessageId, text);
  }

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
// It receives a count and whether the Turn answered, never tool names or input, so nothing raw can reach SQLite or Discord.
function permissionDenialNotifier(database: OperationalStore, transport: ChatTransport, provider: "claude" | "opencode", name: string): (agentSessionId: string, count: number, completed: boolean) => void {
  const declined = permissionDeclinedNotice(name);
  const skipped = permissionSkippedNotice(name);
  return (agentSessionId, count, completed) => {
    const notice = completed ? skipped : declined;
    void (async () => {
      const session = await database.findSessionByAgentSession(provider, agentSessionId);
      if (!session) return;
      const bound = await database.getSession(session.id);
      if (!bound) return;
      await database.createEvent({ session_id: session.id, message_id: null, event_type: "approval_unsupported",
        detail: `declined: no safe action preview; turn=${completed ? "completed" : "failed"}; denials=${count}` }, `runtime:${provider}`);
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

export function claudePermissionDenialNotifier(database: OperationalStore, transport: ChatTransport): (agentSessionId: string, count: number, completed: boolean) => void {
  return permissionDenialNotifier(database, transport, "claude", "Claude");
}

export function openCodePermissionDenialNotifier(database: OperationalStore, transport: ChatTransport): (agentSessionId: string, count: number, completed: boolean) => void {
  return permissionDenialNotifier(database, transport, "opencode", "OpenCode");
}
