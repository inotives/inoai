import type { DatabaseSync } from "node:sqlite";

import type { AgentRuntime, RuntimeFailureKind } from "./agent-runtime.js";
import { resumeAgentSession, startAgentSession } from "./agent-session.js";
import { archiveFailureNotice, archiveResponseChunks, claimNextMessage, claimResponseChunk, confirmResponseChunk, createEvent, failProcessingMessage, failRemainingResponseChunks, failResponseChunk, getSession, listPendingResponseChunks, markRuntimeStarted } from "./database.js";
import type { Configuration } from "./config.js";
import type { MessageRecord } from "./database.js";
import type { RuntimeHome } from "./runtime-home.js";
import { composeTurnPrompt } from "./prompt-context.js";
import { runRuntimeTurn } from "./runtime-turn.js";
import { KnownDeliveryFailure } from "./transport.js";
import type { ChatTransport } from "./transport.js";

const failureNotice = "I couldn't complete that turn safely. Please check the local archive before sending a new request.";
const uncertainNotice = "I can't confirm whether that turn completed. I won't replay it automatically. Please check the local archive.";
const providerNoticeKinds = new Set<RuntimeFailureKind>(["authentication", "usage", "session_missing"]);
// A fixed map keeps an arbitrary stored provider value out of the notice text.
const providerNames: Record<string, string> = { codex: "a Codex", claude: "a Claude", opencode: "an OpenCode" };

function providerMismatchNotice(storedProvider: string, currentDisplayName: string): string {
  const owner = Object.hasOwn(providerNames, storedProvider) ? `${providerNames[storedProvider]} session` : "a session from a different agent provider";
  return `This thread belongs to ${owner}. Use /inoai reset to start a new ${currentDisplayName} session here, or start a new thread.`;
}

export function splitFinalAnswer(answer: string, limit = 2000): string[] {
  if (!answer.trim() || limit < 2) throw new RangeError("Final answer must be nonblank and have a usable limit");
  const chunks: string[] = [];
  let remaining = answer;
  while (remaining.length > limit) {
    let end = limit;
    if (/^[\uD800-\uDBFF]$/.test(remaining[end - 1])) end--;
    const breakAt = Math.max(remaining.lastIndexOf("\n", end - 1), remaining.lastIndexOf(" ", end - 1));
    if (breakAt >= end / 2) end = breakAt + 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class ConversationWorker {
  private readonly active = new Map<number, Promise<void>>();
  private readonly activeAgentSessionIds = new Map<number, string>();
  private readonly turnCancellation = new Map<number, AbortController>();
  private delivery: Promise<void> | undefined;
  private recoveryChecked = false;
  private mode: "global" | "per-session" = "global";
  private stopping = false;

  constructor(
    private readonly database: DatabaseSync,
    private readonly home: RuntimeHome,
    private readonly runtime: AgentRuntime,
    private readonly agentProvider: Configuration["agentProvider"],
    private readonly onFailure: (error: Error) => void = () => {},
    private readonly transport?: Pick<ChatTransport, "sendMessage" | "showWorking">,
  ) {}

  wake(): void {
    if (this.stopping) return;
    try {
      if (this.transport && !this.recoveryChecked) {
        const recovered = this.database.prepare(`SELECT id FROM messages WHERE direction = 'user' AND state = 'failed'
          AND failure_detail = 'Runtime outcome uncertain after restart' AND updated_by = 'startup-recovery'
          AND deleted_at IS NULL`).all() as Array<{ id: number }>;
        for (const row of recovered) archiveFailureNotice(this.database, row.id, uncertainNotice, "startup-recovery");
        this.recoveryChecked = true;
      }
      if (this.transport && !this.delivery) {
        this.delivery = this.deliverPending().catch((error: unknown) => {
          this.onFailure(error instanceof Error ? error : new Error("Response delivery failed"));
        }).finally(() => {
          this.delivery = undefined;
          if (!this.stopping && listPendingResponseChunks(this.database).length) this.wake();
        });
      }
      while (this.mode === "per-session" || this.active.size === 0) {
        const message = claimNextMessage(this.database, this.mode, "conversation-worker");
        if (!message) break;
        this.turnCancellation.set(message.id, new AbortController());
        const running = this.process(message).catch((error: unknown) => {
          this.onFailure(error instanceof Error ? error : new Error("Conversation worker failed"));
        }).finally(() => {
          this.active.delete(message.id);
          this.turnCancellation.delete(message.id);
          this.wake();
        });
        this.active.set(message.id, running);
      }
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error("Conversation worker failed"));
    }
  }

  enablePerSessionConcurrency(): void {
    if (this.stopping) return;
    this.mode = "per-session";
    this.wake();
  }

  fallbackToGlobal(): void {
    if (this.mode === "per-session") console.warn(`${this.runtime.displayName} cross-session concurrency disabled; using global FIFO`);
    this.mode = "global";
    this.wake();
  }

  concurrencyMode(): "global" | "per-session" { return this.mode; }

  async cancelSession(sessionId: number): Promise<boolean> {
    const running = this.database.prepare(`SELECT id FROM messages WHERE session_id = ? AND direction = 'user'
      AND state = 'processing' AND deleted_at IS NULL`).all(sessionId) as Array<{ id: number }>;
    for (const { id } of running) {
      this.turnCancellation.get(id)?.abort();
      const agentSessionId = this.activeAgentSessionIds.get(id);
      if (agentSessionId) await this.runtime.cancel(agentSessionId);
    }
    return running.length > 0;
  }

  async idle(): Promise<void> {
    while (this.active.size || this.delivery) {
      await Promise.all([...this.active.values(), ...(this.delivery ? [this.delivery] : [])]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const cancellation of this.turnCancellation.values()) cancellation.abort();
    try {
      await Promise.allSettled([...this.activeAgentSessionIds.values()].map((id) => this.runtime.cancel(id)));
    } finally {
      try { await this.idle(); }
      finally { await this.runtime.close(); }
    }
  }

  private async process(message: MessageRecord): Promise<void> {
    const cancellation = this.turnCancellation.get(message.id)!;
    const session = getSession(this.database, message.session_id);
    const showWorking = () => { if (session && !cancellation.signal.aborted) void this.transport?.showWorking?.(session.conversation_id).catch(() => undefined); };
    showWorking();
    const indicator = this.transport?.showWorking ? setInterval(showWorking, 8_000) : undefined;
    indicator?.unref();
    try {
      if (!session || session.state !== "active") return;
      if (session.agent_provider !== this.agentProvider) {
        // Never start or resume another provider's Session; the owner resets or opens a new thread.
        if (!failProcessingMessage(this.database, message.id, "Agent provider mismatch; replay_safe=false", "conversation-worker")) return;
        createEvent(this.database, { session_id: session.id, message_id: message.id,
          event_type: "turn_failed", detail: "reason=provider_mismatch; attempts=0" }, "conversation-worker");
        archiveFailureNotice(this.database, message.id, providerMismatchNotice(session.agent_provider, this.runtime.displayName));
        return;
      }
      const agentSessionId = session.agent_session_id.startsWith("pending:")
        ? await startAgentSession(this.database, this.runtime, session.id, this.home)
        : await resumeAgentSession(this.database, this.runtime, session.id, this.home);
      const prompt = composeTurnPrompt(this.database, message);
      if (this.stopping || cancellation.signal.aborted || !markRuntimeStarted(this.database, message.id)) {
        if (cancellation.signal.aborted) failProcessingMessage(this.database, message.id, "Cancelled by owner", "user:owner");
        return;
      }
      this.activeAgentSessionIds.set(message.id, agentSessionId);
      const outcome = await runRuntimeTurn(this.database, this.runtime, session.id, agentSessionId, prompt, undefined, message.id, cancellation.signal);
      if (cancellation.signal.aborted) {
        failProcessingMessage(this.database, message.id, "Cancelled by owner", "user:owner");
        return;
      }
      if (outcome.state === "completed") {
        if (outcome.answer?.trim()) {
          archiveResponseChunks(this.database, message.id, splitFinalAnswer(outcome.answer), "conversation-worker");
        } else if (failProcessingMessage(this.database, message.id, "Runtime returned no final answer", "conversation-worker")) {
          createEvent(this.database, { session_id: session.id, message_id: message.id,
            event_type: "turn_failed", detail: "reason=empty_answer" }, "conversation-worker");
          archiveFailureNotice(this.database, message.id, failureNotice);
        }
      } else {
        if (outcome.reason === "uncertain" || outcome.reason === "timed_out") this.fallbackToGlobal();
        if (!failProcessingMessage(this.database, message.id, `Runtime ${outcome.reason}; replay_safe=${outcome.replaySafe}`, "conversation-worker")) return;
        createEvent(this.database, { session_id: session.id, message_id: message.id,
          event_type: "turn_failed", detail: `reason=${outcome.reason}; attempts=${outcome.attempts}` }, "conversation-worker");
        // Only these kinds carry fixed provider-worded guidance the owner can act on; the rest stay generic.
        archiveFailureNotice(this.database, message.id, providerNoticeKinds.has(outcome.reason) ? outcome.notice
          : outcome.reason === "uncertain" || outcome.reason === "timed_out" ? uncertainNotice : failureNotice);
      }
    } catch {
      this.fallbackToGlobal();
      const detail = message.runtime_started_at === null && !this.activeAgentSessionIds.has(message.id)
        ? "Agent Session setup failed before runtime start" : "Runtime outcome uncertain";
      if (failProcessingMessage(this.database, message.id, detail, "conversation-worker")) {
        createEvent(this.database, { session_id: message.session_id, message_id: message.id,
          event_type: "turn_failed", detail }, "conversation-worker");
        archiveFailureNotice(this.database, message.id, detail.includes("uncertain") ? uncertainNotice : failureNotice);
      }
      // The user turn has a terminal safe outcome; later queued work may continue.
    } finally {
      if (indicator) clearInterval(indicator);
      this.activeAgentSessionIds.delete(message.id);
    }
  }

  private async deliverPending(): Promise<void> {
    if (!this.transport) return;
    for (const chunk of listPendingResponseChunks(this.database)) {
      if (this.stopping) return;
      const inboundId = chunk.in_reply_to_message_id;
      if (inboundId === null) continue;
      const earlier = this.database.prepare(`SELECT delivery_state FROM messages WHERE in_reply_to_message_id = ?
        AND direction = 'agent' AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get(inboundId, chunk.id) as { delivery_state: string } | undefined;
      if (earlier && earlier.delivery_state !== "confirmed") {
        failRemainingResponseChunks(this.database, inboundId);
        createEvent(this.database, { session_id: chunk.session_id, message_id: chunk.id,
          event_type: "response_delivery_skipped", detail: "Earlier response chunk was not confirmed" }, "transport:discord");
        continue;
      }
      const session = getSession(this.database, chunk.session_id);
      if (!claimResponseChunk(this.database, chunk.id)) continue;
      try {
        if (!session || session.state !== "active") throw new KnownDeliveryFailure("Session unavailable before send");
        const id = await this.transport.sendMessage(session.conversation_id, chunk.body);
        if (!confirmResponseChunk(this.database, chunk.id, id)) throw new Error("Response chunk confirmation failed");
      } catch (error) {
        if (error instanceof KnownDeliveryFailure) failResponseChunk(this.database, chunk.id, "Discord rejected delivery before send");
        // A send rejection or crash after claim may have reached Discord. Keep it uncertain.
        failRemainingResponseChunks(this.database, inboundId);
        createEvent(this.database, { session_id: chunk.session_id, message_id: chunk.id,
          event_type: "response_delivery_failed", detail: error instanceof KnownDeliveryFailure ? "known_pre_send_failure" : "uncertain_after_send_attempt" }, "transport:discord");
      }
    }
  }
}
