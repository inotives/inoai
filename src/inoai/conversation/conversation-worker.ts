import type { AgentRuntime, RuntimeFailureKind } from "../agent-runtime/ports.js";
import { resumeAgentSession, startAgentSession } from "./agent-session.js";
import type { Configuration } from "../agent-instance/config.js";
import type { MessageRecord, OperationalStore } from "../persistence/operational-store.js";
import type { RuntimeHome } from "../agent-instance/runtime-home.js";
import { composeTurnContext } from "./prompt-context.js";
import { runRuntimeTurn } from "./runtime-turn.js";
import { KnownDeliveryFailure } from "./transport-port.js";
import type { ConversationTransport } from "./transport-port.js";
import { buildEnabledSkillIndex, loadSelectedSkill, selectEnabledSkill } from "../skills/skill-loader.js";
import { prepareSkillScripts, skillExecutionInstructions } from "../skills/skill-execution.js";
import type { TaskOperationsStore } from "../connectors/persistence/sqlite/operational-store.js";
import type { SessionRecord, TaskProposalRecord, TaskRecord } from "../connectors/persistence/sqlite/legacy-database.js";
import { extractTaskBlock, taskBlockInstruction, validateTaskBlock } from "../tasks/task-block.js";

const failureNotice = "I couldn't complete that turn safely. Please check the local archive before sending a new request.";
const uncertainNotice = "I can't confirm whether that turn completed. I won't replay it automatically. Please check the local archive.";
// Fixed texts archived as agent Messages; Memory Reviews exclude them from the reviewed transcript.
export const fixedTurnNotices: readonly string[] = [failureNotice, uncertainNotice];
const providerNoticeKinds = new Set<RuntimeFailureKind>(["authentication", "usage", "session_missing"]);
// A fixed map keeps an arbitrary stored provider value out of the notice text.
const providerNames: Record<string, string> = { codex: "a Codex", claude: "a Claude", opencode: "an OpenCode" };

export function providerMismatchNotice(storedProvider: string, currentDisplayName: string): string {
  const owner = Object.hasOwn(providerNames, storedProvider) ? `${providerNames[storedProvider]} session` : "a session from a different agent provider";
  return `This thread belongs to ${owner}. Use /inoai reset to start a new ${currentDisplayName} session here, or start a new thread.`;
}

const proposalLifetimeSeconds = 24 * 60 * 60;
const proposalStoreFailedNote = "Task card not created: the proposal could not be saved. Please ask again.";

/** Chat-proposed Tasks: owner turns in normal conversations get the Task block instruction and may create proposals. */
export type ChatTaskOptions = {
  store: Pick<TaskOperationsStore, "listTasks" | "createTaskProposal"> & Partial<Pick<TaskOperationsStore, "expireSessionTaskProposals">>;
  ownerUserId: number;
  ownerTimeZone: string;
  /** Receives each new pending proposal after its answer chunks leave the delivery queue, so the card follows them. */
  onProposal?: (proposal: TaskProposalRecord, message: MessageRecord) => Promise<void> | void;
  now?: () => number;
};

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
  private queueListener: (() => void) | undefined;
  private pumpPromise: Promise<void> | undefined;
  private wakeRequested = false;
  private taskReserved = false;
  private readonly cardsAfterDelivery = new Map<number, { proposal: TaskProposalRecord; message: MessageRecord }>();

  constructor(
    private readonly database: OperationalStore,
    private readonly home: RuntimeHome,
    private readonly runtime: AgentRuntime,
    private readonly agentProvider: Configuration["agentProvider"],
    private readonly onFailure: (error: Error) => void = () => {},
    private readonly transport?: ConversationTransport,
    private readonly chatTasks?: ChatTaskOptions,
  ) {}

  wake(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pumpPromise) { this.wakeRequested = true; return this.pumpPromise; }
    this.pumpPromise ??= this.pump().catch((error: unknown) => this.onFailure(error instanceof Error ? error : new Error("Conversation worker failed"))).finally(() => { this.pumpPromise = undefined; });
    return this.pumpPromise;
  }

  private async pump(): Promise<void> {
    try {
      if (this.transport && !this.recoveryChecked) {
        await this.database.recoverStaleWork("startup-recovery");
        this.recoveryChecked = true;
      }
      if (this.transport && !this.delivery) {
        this.delivery = this.deliverPending().catch((error: unknown) => {
          this.onFailure(error instanceof Error ? error : new Error("Response delivery failed"));
        }).finally(() => {
          this.delivery = undefined;
          if (!this.stopping) this.wakeRequested = true;
        });
      }
      while (!this.taskReserved && (this.mode === "per-session" || this.active.size === 0)) {
        const message = await this.database.claimNextMessage(this.mode, "conversation-worker");
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
      if (this.wakeRequested && !this.stopping) {
        this.wakeRequested = false;
        await this.pump();
      }
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error("Conversation worker failed"));
    } finally {
      if (!this.stopping) this.queueListener?.();
    }
  }

  // The Memory Review scheduler's hook: every inbound archive and Turn transition goes through wake(), so the
  // listener hears each chat queue change and reads the queue state from SQLite itself.
  onQueueChange(listener: () => void): void {
    this.queueListener = listener;
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

  async reserveTaskRun(): Promise<(() => void) | undefined> {
    if (this.stopping || this.taskReserved) return undefined;
    this.taskReserved = true;
    try {
      await this.idle();
      if (!await this.database.chatBusy()) return () => { this.taskReserved = false; void this.wake(); };
    } catch (error) {
      this.taskReserved = false;
      void this.wake();
      throw error;
    }
    this.taskReserved = false;
    void this.wake();
    return undefined;
  }

  async cancelSession(sessionId: number): Promise<boolean> {
    const messages = await this.database.listMessages(sessionId);
    const running = messages.filter((message) => message.direction === "user" && message.state === "processing");
    for (const { id } of running) {
      this.turnCancellation.get(id)?.abort();
      const agentSessionId = this.activeAgentSessionIds.get(id);
      if (agentSessionId) await this.runtime.cancel(agentSessionId);
    }
    return running.length > 0;
  }

  async idle(): Promise<void> {
    while (this.active.size || this.delivery || this.pumpPromise) {
      await Promise.all([...this.active.values(), ...(this.delivery ? [this.delivery] : []), ...(this.pumpPromise ? [this.pumpPromise] : [])]);
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
    const session = await this.database.getSession(message.session_id);
    const showWorking = () => { if (session && !cancellation.signal.aborted) void this.transport?.showWorking?.(session.conversation_id).catch(() => undefined); };
    showWorking();
    const indicator = this.transport?.showWorking ? setInterval(showWorking, 8_000) : undefined;
    indicator?.unref();
    try {
      if (!session || session.state !== "active") return;
      if (session.agent_provider !== this.agentProvider) {
        // Never start or resume another provider's Session; the owner resets or opens a new thread.
        if (!await this.database.failProcessingMessage(message.id, "Agent provider mismatch; replay_safe=false", "conversation-worker")) return;
        await this.database.createEvent({ session_id: session.id, message_id: message.id,
          event_type: "turn_failed", detail: "reason=provider_mismatch; attempts=0" }, "conversation-worker");
        await this.database.archiveFailureNotice(message.id, providerMismatchNotice(session.agent_provider, this.runtime.displayName));
        return;
      }
      const agentSessionId = session.agent_session_id.startsWith("pending:")
        ? await startAgentSession(this.database, this.runtime, session.id, this.home)
        : await resumeAgentSession(this.database, this.runtime, session.id, this.home);
      const composed = await composeTurnContext(this.database, message);
      let prompt = composed.prompt;
      const tasks = await this.chatTaskList(session, message);
      if (tasks) prompt += `\n\n${taskBlockInstruction(tasks, this.chatTasks!.ownerTimeZone, this.now())}`;
      const selected = selectEnabledSkill(await buildEnabledSkillIndex(this.home), { prompt: message.body });
      const skillInstructions = selected ? await loadSelectedSkill(this.home, { skillId: selected.id }) : undefined;
      if (selected && skillInstructions) {
        prompt += skillInstructions;
        const scripts = await prepareSkillScripts(this.home, session.project_path, { skillId: selected.id });
        if (scripts.length) prompt += scripts.map(skillExecutionInstructions).join("\n");
        try {
          await this.database.createEvent({ session_id: session.id, message_id: message.id,
            event_type: "skill_selected", detail: `skill=${selected.id}; version=${selected.version}` }, "conversation-worker");
        } catch {
          // Skill selection recording is best effort and never fails the turn.
        }
      }
      if (this.stopping || cancellation.signal.aborted || !await this.database.markRuntimeStarted(message.id)) {
        if (cancellation.signal.aborted) await this.database.failProcessingMessage(message.id, "Cancelled by owner", "user:owner");
        return;
      }
      this.activeAgentSessionIds.set(message.id, agentSessionId);
      await this.recordMemoryUses(session.id, message.id, composed.memoryIds);
      const outcome = await runRuntimeTurn(this.database, this.runtime, session.id, agentSessionId, prompt, undefined, message.id, cancellation.signal);
      if (cancellation.signal.aborted) {
        await this.database.failProcessingMessage(message.id, "Cancelled by owner", "user:owner");
        return;
      }
      if (outcome.state === "completed") {
        const extracted = extractTaskBlock(outcome.answer ?? "");
        if (extracted.found) {
          await this.archiveWithTaskBlock(session, message, extracted, tasks);
        } else if (outcome.answer?.trim()) {
          await this.database.archiveResponseChunks(message.id, splitFinalAnswer(outcome.answer), "conversation-worker");
        } else if (await this.database.failProcessingMessage(message.id, "Runtime returned no final answer", "conversation-worker")) {
          await this.database.createEvent({ session_id: session.id, message_id: message.id,
            event_type: "turn_failed", detail: "reason=empty_answer" }, "conversation-worker");
          await this.database.archiveFailureNotice(message.id, failureNotice);
        }
      } else {
        if (outcome.reason === "uncertain" || outcome.reason === "timed_out") this.fallbackToGlobal();
        if (!await this.database.failProcessingMessage(message.id, `Runtime ${outcome.reason}; replay_safe=${outcome.replaySafe}`, "conversation-worker")) return;
        await this.database.createEvent({ session_id: session.id, message_id: message.id,
          event_type: "turn_failed", detail: `reason=${outcome.reason}; attempts=${outcome.attempts}` }, "conversation-worker");
        // Only these kinds carry fixed provider-worded guidance the owner can act on; the rest stay generic.
        await this.database.archiveFailureNotice(message.id, providerNoticeKinds.has(outcome.reason) ? outcome.notice
          : outcome.reason === "uncertain" || outcome.reason === "timed_out" ? uncertainNotice : failureNotice);
      }
    } catch {
      this.fallbackToGlobal();
      const detail = message.runtime_started_at === null && !this.activeAgentSessionIds.has(message.id)
        ? "Agent Session setup failed before runtime start" : "Runtime outcome uncertain";
      if (await this.database.failProcessingMessage(message.id, detail, "conversation-worker")) {
        await this.database.createEvent({ session_id: message.session_id, message_id: message.id,
          event_type: "turn_failed", detail }, "conversation-worker");
        await this.database.archiveFailureNotice(message.id, detail.includes("uncertain") ? uncertainNotice : failureNotice);
      }
      // The user turn has a terminal safe outcome; later queued work may continue.
    } finally {
      if (indicator) clearInterval(indicator);
      this.activeAgentSessionIds.delete(message.id);
    }
  }

  private now(): number { return this.chatTasks?.now?.() ?? Math.floor(Date.now() / 1000); }

  // One `memory_uses` row per Memory in the started Turn's prompt. Best effort: a failed write never fails the Turn.
  private async recordMemoryUses(sessionId: number, messageId: number, memoryIds: number[]): Promise<void> {
    if (!memoryIds.length || !this.database.recordMemoryUses) return;
    try {
      await this.database.recordMemoryUses(memoryIds.map((memory_id) => ({ memory_id, session_id: sessionId, message_id: messageId,
        task_run_id: null })), this.now(), "conversation-worker");
    } catch {
      // Usage records are best effort.
    }
  }

  // Owner turns in normal conversations only. Task threads never reach this worker as pending turns, but a Task's
  // Session is excluded here too. Returns undefined when the turn gets no Task instruction.
  private async chatTaskList(session: SessionRecord, message: MessageRecord): Promise<TaskRecord[] | undefined> {
    if (!this.chatTasks || message.user_id !== this.chatTasks.ownerUserId || session.agent_session_id.startsWith("pending:task:")) return undefined;
    try {
      const tasks = await this.chatTasks.store.listTasks();
      return tasks.some((task) => task.session_id === session.id) ? undefined : tasks;
    } catch {
      return undefined; // Without the Task list the turn runs without the instruction; it never fails the turn.
    }
  }

  // The raw block never reaches the archive or Discord. A block-only answer archives only its note, or nothing.
  private async archiveWithTaskBlock(session: SessionRecord, message: MessageRecord,
    extracted: ReturnType<typeof extractTaskBlock> & { found: true }, tasks: TaskRecord[] | undefined): Promise<void> {
    let note: string | undefined;
    let proposal: TaskProposalRecord | undefined;
    if (tasks && this.chatTasks) {
      const now = this.now();
      const result = validateTaskBlock(extracted, { ownerTimeZone: this.chatTasks.ownerTimeZone, now, taskIds: new Set(tasks.map((task) => task.id)) });
      let detail: string;
      if (result.ok) {
        try {
          proposal = await this.chatTasks.store.createTaskProposal({ session_id: session.id, transport: session.transport,
            workspace_id: session.workspace_id, conversation_id: session.conversation_id, kind: result.proposal.kind,
            task_id: result.proposal.taskId, spec_json: result.proposal.spec ? JSON.stringify(result.proposal.spec) : null,
            expires_at: now + proposalLifetimeSeconds }, now, "discord:owner");
          detail = `proposal=${proposal.id}; kind=${proposal.kind}; task=${proposal.task_id ?? "new"}`;
        } catch {
          note = proposalStoreFailedNote;
          detail = "reason=store_failed";
        }
      } else {
        note = result.rejection.note;
        detail = `reason=${result.rejection.reason}${result.rejection.fields.length ? `; fields=${result.rejection.fields.join(",")}` : ""}`;
      }
      await this.recordBestEffort(session.id, message.id, proposal ? "task_proposal_created" : "task_proposal_rejected", detail);
    }
    const text = note ? (extracted.answer ? `${extracted.answer}\n\n${note}` : note) : extracted.answer;
    const archived = await this.database.archiveResponseChunks(message.id, text ? splitFinalAnswer(text) : [], "conversation-worker");
    if (!proposal) return;
    if (!archived) {
      // A reset ended the turn after the proposal was stored; its card is never posted.
      await this.chatTasks?.store.expireSessionTaskProposals?.(session.id, this.now(), "system").catch(() => undefined);
      return;
    }
    if (this.transport) this.cardsAfterDelivery.set(message.id, { proposal, message });
    else await this.sendCard(proposal, message);
  }

  private async sendCard(proposal: TaskProposalRecord, message: MessageRecord): Promise<void> {
    try {
      await this.chatTasks?.onProposal?.(proposal, message);
    } catch {
      // Card delivery owns its own failure handling; the turn already has its archived answer.
    }
  }

  // Posts each waiting card once no answer chunk of its turn is still waiting for delivery.
  private async sendDeliveredCards(): Promise<void> {
    for (const [inboundId, entry] of [...this.cardsAfterDelivery]) {
      if (this.stopping) return;
      const rows = await this.database.listMessages(entry.message.session_id);
      if (rows.some((row) => row.direction === "agent" && row.in_reply_to_message_id === inboundId && row.delivery_state === "pending")) continue;
      this.cardsAfterDelivery.delete(inboundId);
      await this.sendCard(entry.proposal, entry.message);
    }
  }

  private async recordBestEffort(sessionId: number, messageId: number, eventType: string, detail: string): Promise<void> {
    try {
      await this.database.createEvent({ session_id: sessionId, message_id: messageId, event_type: eventType, detail }, "conversation-worker");
    } catch {
      // Proposal event recording never fails the turn.
    }
  }

  private async deliverPending(): Promise<void> {
    if (!this.transport) return;
    for (const chunk of await this.database.listPendingResponseChunks()) {
      if (this.stopping) return;
      const inboundId = chunk.in_reply_to_message_id;
      if (inboundId === null) continue;
      const earlier = (await this.database.listMessages(chunk.session_id)).filter((row) => row.in_reply_to_message_id === inboundId && row.direction === "agent" && row.id < chunk.id).at(-1);
      if (earlier && earlier.delivery_state !== "confirmed") {
        await this.database.failRemainingResponseChunks(inboundId);
        await this.database.createEvent({ session_id: chunk.session_id, message_id: chunk.id,
          event_type: "response_delivery_skipped", detail: "Earlier response chunk was not confirmed" }, "transport:discord");
        continue;
      }
      const session = await this.database.getSession(chunk.session_id);
      if (!await this.database.claimResponseChunk(chunk.id)) continue;
      try {
        if (!session || session.state !== "active") throw new KnownDeliveryFailure("Session unavailable before send");
        const id = await this.transport.sendMessage(session.conversation_id, chunk.body);
        if (!await this.database.confirmResponseChunk(chunk.id, id)) throw new Error("Response chunk confirmation failed");
      } catch (error) {
        if (error instanceof KnownDeliveryFailure) await this.database.failResponseChunk(chunk.id, "Discord rejected delivery before send");
        // A send rejection or crash after claim may have reached Discord. Keep it uncertain.
        await this.database.failRemainingResponseChunks(inboundId);
        await this.database.createEvent({ session_id: chunk.session_id, message_id: chunk.id,
          event_type: "response_delivery_failed", detail: error instanceof KnownDeliveryFailure ? "known_pre_send_failure" : "uncertain_after_send_attempt" }, "transport:discord");
      }
    }
    await this.sendDeliveredCards();
  }
}
