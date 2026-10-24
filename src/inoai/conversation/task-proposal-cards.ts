// Discord confirm cards for chat-proposed Tasks: posts the card, handles its buttons, and removes the buttons of
// resolved proposals. The owner check happens in app.ts before a click reaches this class.
import type { TaskOperationsStore } from "../connectors/persistence/sqlite/operational-store.js";
import type { TaskProposalRecord } from "../connectors/persistence/sqlite/legacy-database.js";
import type { SchedulerClock } from "../memory/memory-review-scheduler.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import { describeSchedule, nextRunAt, toTaskColumns, validateTaskSpec, type TaskSpec } from "../tasks/schedule.js";
import type { ButtonClick, ChatTransport, MessageButton } from "../transport/ports.js";
import { KnownDeliveryFailure } from "./transport-port.js";
import type { TaskRunExecutor } from "./task-run-executor.js";

export type TaskCardStore = Pick<OperationalStore, "getSession" | "createSession" | "resetSession" | "listEvents">
  & Pick<TaskOperationsStore, "getTask" | "listTaskRuns" | "createTask" | "pauseTask" | "resumeTask" | "editTask" | "createPendingTask"
    | "getTaskProposal" | "setTaskProposalCardMessage" | "resolveTaskProposal" | "claimTaskProposal" | "finishTaskProposal"
    | "expireOverdueTaskProposals" | "listOpenTaskProposalCards" | "closeTaskProposalCard">;
type CardTransport = Pick<ChatTransport, "sendMessage" | "createConversation" | "deleteConversation" | "health">
  & Partial<Pick<ChatTransport, "sendMessageWithButtons" | "editMessage" | "deleteMessage">>;
export type TaskCardOptions = {
  /** The owner's internal user id; Discord-created Sessions belong to the owner. */
  ownerUserId: number;
  agentProvider: string;
  projectPath: string;
  taskChannelId?: string;
  taskRunner?: Pick<TaskRunExecutor, "start" | "cancel">;
  clock?: SchedulerClock;
};
type Outcome = { ok: true; taskId: number } | { ok: false; reason: string };

const actor = "discord:owner";
const sweepIntervalMs = 60_000;
const customIdPattern = /^inoai:proposal:(\d{1,15}):(create|cancel)$/;
const restartFailure = "inoai stopped before this finished. Check your tasks before asking again.";
const systemClock: SchedulerClock = {
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

function clip(text: string, limit: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function threadName(title: string): string {
  return Array.from(title.replace(/\s+/g, " ").trim() || "inoai Task").slice(0, 100).join("");
}

function localTime(unixSeconds: number, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(unixSeconds * 1000))) parts[type] = value;
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function nextRuns(spec: TaskSpec, now: number, runsSoFar: number, count: number): number[] {
  const runs: number[] = [];
  let after = now;
  for (let index = 0; index < count; index += 1) {
    const next = nextRunAt(spec, after, runsSoFar + index);
    if (next === null || (runs.length > 0 && next <= after)) break;
    runs.push(next);
    after = next;
  }
  return runs;
}

/** Create and Cancel buttons. Labels stay within 80 characters and custom ids within 100 (Discord limits). */
export function cardButtons(proposal: Pick<TaskProposalRecord, "id" | "kind">): MessageButton[] {
  const buttons: MessageButton[] = [
    { label: proposal.kind === "create" ? "Create" : "Confirm", style: proposal.kind === "cancel" ? "danger" : "success",
      customId: `inoai:proposal:${proposal.id}:create` },
    { label: "Cancel", style: "secondary", customId: `inoai:proposal:${proposal.id}:cancel` },
  ];
  if (buttons.some((button) => button.label.length > 80 || button.customId.length > 100)) throw new KnownDeliveryFailure("Card button exceeds Discord limits");
  return buttons;
}

export class TaskProposalCards {
  private readonly clock: SchedulerClock;
  private interval: unknown;
  private stopped = false;
  private sweeping?: Promise<void>;
  private sweepAgain = false;
  /** Proposals whose click is still confirming or closing its card; the sweep leaves them to the click. */
  private readonly inFlight = new Set<number>();

  constructor(private readonly store: TaskCardStore, private readonly transport: CardTransport, private readonly options: TaskCardOptions) {
    this.clock = options.clock ?? systemClock;
  }

  private now(): number { return Math.floor(this.clock.now().getTime() / 1000); }

  /** Starts the periodic expiry check. */
  start(): void {
    if (this.stopped || this.interval !== undefined) return;
    this.interval = this.clock.setInterval(() => { void this.sweep(); }, sweepIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval !== undefined) this.clock.clearInterval(this.interval);
    this.interval = undefined;
    await this.sweeping;
  }

  /** Posts the card for a new pending proposal. Card sends follow ADR 0005: a failed send is never retried. */
  async deliver(proposal: TaskProposalRecord): Promise<void> {
    if (this.stopped || !this.transport.sendMessageWithButtons) return;
    const current = await this.store.getTaskProposal(proposal.id);
    if (current?.state !== "pending") return;
    let messageId: string;
    try {
      const text = await this.pendingText(current);
      messageId = await this.transport.sendMessageWithButtons(current.conversation_id, text, cardButtons(current));
    } catch (error) {
      // Without a stored card the proposal cannot be confirmed; it ends as failed.
      await this.store.resolveTaskProposal(current.id, "failed", this.now(), "transport:discord", null,
        error instanceof KnownDeliveryFailure ? "card_known_pre_send_failure" : "card_uncertain_after_send_attempt").catch(() => undefined);
      return;
    }
    if (!await this.store.setTaskProposalCardMessage(current.id, messageId, this.now(), "transport:discord")) {
      // Reset or replaced while the card was sent: the card id is not stored, so remove its buttons here.
      const latest = await this.store.getTaskProposal(current.id);
      if (latest) await this.transport.editMessage?.(current.conversation_id, messageId, await this.statusText(latest), []).catch(() => undefined);
    }
    // Not awaited: this runs inside the shared delivery pump, which must not wait for other cards' edits.
    void this.sweep();
  }

  /** Handles a Create or Cancel click from the owner. Every click is answered at once; slow work follows. */
  async handleClick(click: ButtonClick): Promise<void> {
    const match = customIdPattern.exec(click.customId);
    if (!match) { await click.replyEphemeral("This button is no longer available."); return; }
    const id = Number(match[1]);
    const proposal = await this.store.getTaskProposal(id);
    if (!proposal || proposal.card_message_id !== click.messageId || proposal.conversation_id !== click.conversationId
      || proposal.workspace_id !== click.workspaceId) {
      await click.replyEphemeral("This card is no longer active.");
      return;
    }
    if (match[2] === "cancel") {
      const { resolved, proposal: current } = await this.store.resolveTaskProposal(id, "cancelled", this.now(), actor);
      await this.answerResolved(click, current!, resolved);
      return;
    }
    const { claimed, proposal: current } = await this.store.claimTaskProposal(id, this.now(), actor);
    if (!claimed) { await this.answerResolved(click, current!, false); return; }
    this.inFlight.add(id);
    try {
      await click.updateMessage(await this.statusText(current!), []).catch(() => undefined);
      let outcome: Outcome;
      try {
        outcome = await this.confirm(current!);
      } catch {
        outcome = { ok: false, reason: "error" };
      }
      const { proposal: finished } = await this.store.finishTaskProposal(id, outcome.ok ? "confirmed" : "failed", this.now(), actor,
        outcome.ok ? outcome.taskId : null, outcome.ok ? undefined : outcome.reason);
      if (finished) await this.closeCard(finished);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Expires overdue proposals and removes the buttons of every resolved card that still has them. */
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweeping) { this.sweepAgain = true; return this.sweeping; }
    this.sweeping = (async () => {
      if (this.transport.health().state !== "ready") return;
      await this.store.expireOverdueTaskProposals(this.now(), "system");
      for (const card of await this.store.listOpenTaskProposalCards()) {
        if (this.stopped) return;
        if (!this.inFlight.has(card.id)) await this.closeCard(card, card.replaced);
      }
    })().catch(() => undefined).finally(() => {
      this.sweeping = undefined;
      if (this.sweepAgain && !this.stopped) { this.sweepAgain = false; void this.sweep(); }
    });
    return this.sweeping;
  }

  private async answerResolved(click: ButtonClick, proposal: TaskProposalRecord, changed: boolean): Promise<void> {
    if (proposal.state === "confirming" || proposal.state === "pending") {
      await click.replyEphemeral("This card is already being confirmed.");
      return;
    }
    const replaced = !changed && proposal.state === "expired"
      && (await this.store.listOpenTaskProposalCards()).some((card) => card.id === proposal.id && card.replaced);
    await click.updateMessage(await this.statusText(proposal, replaced), []);
    await this.store.closeTaskProposalCard(proposal.id, this.now(), "transport:discord");
  }

  private async closeCard(proposal: TaskProposalRecord, replaced = false): Promise<void> {
    if (!proposal.card_message_id) return;
    try {
      await this.transport.editMessage?.(proposal.conversation_id, proposal.card_message_id, await this.statusText(proposal, replaced), []);
    } catch {
      // Card edits are best effort; a later click still answers with the stored state.
    }
    await this.store.closeTaskProposalCard(proposal.id, this.now(), "transport:discord");
  }

  private async confirm(proposal: TaskProposalRecord): Promise<Outcome> {
    const fail = (reason: string): Outcome => ({ ok: false, reason });
    const now = this.now();
    const taskId = proposal.task_id!;
    if (proposal.kind === "create" || proposal.kind === "edit") {
      const checked = validateTaskSpec(JSON.parse(proposal.spec_json!), now);
      if (!checked.ok) return fail("invalid_spec");
      if (proposal.kind === "edit") {
        const result = await this.store.editTask(taskId, checked.spec, now, actor);
        if (result === "edited") return { ok: true, taskId };
        return fail(result);
      }
      return this.createTask(proposal, toTaskColumns(checked.spec, now));
    }
    if (proposal.kind === "pause" || proposal.kind === "resume") {
      const changed = proposal.kind === "pause" ? await this.store.pauseTask(taskId, actor) : await this.store.resumeTask(taskId, actor, now);
      return changed ? { ok: true, taskId } : fail("state");
    }
    const runner = this.options.taskRunner;
    if (!runner) return fail("unavailable");
    if (proposal.kind === "cancel") {
      return await runner.cancel(taskId) ? { ok: true, taskId } : fail("state");
    }
    const result = await runner.start(taskId);
    return result === "started" ? { ok: true, taskId }
      : fail(result === "busy" ? "busy" : "state");
  }

  // Without a task channel: a dedicated thread in the conversation's parent channel, as /inoai task create does.
  // With one: a `pending:ui:` placeholder, and the first run opens the thread in the task channel.
  private async createTask(proposal: TaskProposalRecord, columns: ReturnType<typeof toTaskColumns>): Promise<Outcome> {
    const owner = { user_id: this.options.ownerUserId, transport: proposal.transport, workspace_id: proposal.workspace_id,
      agent_provider: this.options.agentProvider, project_path: this.options.projectPath };
    if (this.options.taskChannelId) {
      try {
        return { ok: true, taskId: (await this.store.createPendingTask(owner, columns, actor)).id };
      } catch {
        return { ok: false, reason: "store_failed" };
      }
    }
    const conversation = await this.store.getSession(proposal.session_id);
    const parent = conversation?.parent_conversation_id;
    let starterId: string | undefined;
    let threadId: string | undefined;
    let sessionId: number | undefined;
    try {
      if (!parent) throw new Error("Conversation parent channel unavailable");
      starterId = await this.transport.sendMessage(parent, "inoai Task thread");
      threadId = await this.transport.createConversation(parent, starterId, threadName(columns.title));
      const session = await this.store.createSession({ ...owner, parent_conversation_id: parent, conversation_id: threadId,
        initiating_external_message_id: starterId, agent_session_id: `pending:task:${threadId}` }, actor);
      sessionId = session.id;
      const task = await this.store.createTask({ ...columns, conversation_id: threadId, session_id: session.id }, actor);
      return { ok: true, taskId: task.id };
    } catch {
      if (sessionId) await this.store.resetSession(sessionId, "task:create-failed").catch(() => undefined);
      if (threadId) await this.transport.deleteConversation(threadId).catch(() => undefined);
      if (starterId && parent) await this.transport.deleteMessage?.(parent, starterId).catch(() => undefined);
      return { ok: false, reason: "thread_failed" };
    }
  }

  private spec(proposal: TaskProposalRecord): TaskSpec {
    return JSON.parse(proposal.spec_json!) as TaskSpec;
  }

  private async subject(proposal: TaskProposalRecord): Promise<string> {
    if (proposal.kind === "create") return `"${clip(this.spec(proposal).title, 100)}"`;
    const task = await this.store.getTask(proposal.task_id!);
    const title = proposal.kind === "edit" ? this.spec(proposal).title : task?.title || task?.goal;
    return `task #${proposal.task_id}${title ? ` "${clip(title, 100)}"` : ""}`;
  }

  private async pendingText(proposal: TaskProposalRecord): Promise<string> {
    const expiry = `This card expires <t:${proposal.expires_at}:R>.`;
    if (proposal.kind !== "create" && proposal.kind !== "edit") {
      const action = { run: "Run task now", pause: "Pause task", resume: "Resume task", cancel: "Cancel task" }[proposal.kind];
      return `**${action}**\n${(await this.subject(proposal)).replace(/^task/, "Task")}\n${expiry}`;
    }
    const spec = this.spec(proposal);
    const runsSoFar = proposal.kind === "edit"
      ? (await this.store.listTaskRuns(proposal.task_id!)).filter((run) => run.state === "completed" || run.state === "failed").length : 0;
    const runs = nextRuns(spec, this.now(), runsSoFar, 3);
    const reports = proposal.kind === "edit" ? "the task's existing thread"
      : this.options.taskChannelId ? "a new thread in the task channel, opened on the first run"
        : "a new thread named after the title, in this conversation's channel";
    return [
      proposal.kind === "create" ? "**New task**" : `**Edit task #${proposal.task_id}**`,
      `Title: ${clip(spec.title, 100)}`,
      `Instruction: ${clip(spec.instruction, 500)}`,
      `Expected output: ${spec.expectedOutput ? clip(spec.expectedOutput, 300) : "Not set"}`,
      `Schedule: ${describeSchedule(spec)}`,
      `Next runs: ${runs.length ? runs.map((run) => localTime(run, spec.timezone)).join("; ") : "none"}`,
      `Time zone: ${spec.timezone}`,
      `Reports: ${reports}`,
      expiry,
    ].join("\n");
  }

  // The failure reason is read from the proposal's stored `task_proposal_failed` event, so every edit shows the same text.
  private async failureText(proposal: TaskProposalRecord): Promise<string> {
    const prefix = `proposal=${proposal.id};`;
    const event = (await this.store.listEvents(proposal.session_id)).filter((row) =>
      row.event_type === "task_proposal_failed" && row.detail?.startsWith(prefix)).at(-1);
    const reason = /; reason=([a-z_]+)$/.exec(event?.detail ?? "")?.[1];
    const task = `Task #${proposal.task_id}`;
    const verb = { create: "", edit: "edited", run: "run", pause: "paused", resume: "resumed", cancel: "cancelled" }[proposal.kind];
    switch (reason) {
      case "invalid_spec": return "The task details are no longer valid. Ask for a new card.";
      case "not_found": return `${task} was not found.`;
      case "not_editable": return "Only active or paused tasks can be edited.";
      case "running": return "A run is in progress. Try again after it finishes.";
      case "no_run_left": return "The schedule has no run left after the runs so far.";
      case "state": return proposal.kind === "run" ? `${task} cannot run from its current state.` : `${task} cannot be ${verb} from its current state.`;
      case "busy": return "Chat or another Task Run is active. Try again when it finishes.";
      case "unavailable": return "Task execution unavailable.";
      case "store_failed": return "The task could not be saved. Nothing was created.";
      case "thread_failed": return "Task creation failed. Check that inoai can create a thread here, then ask again.";
      case "error": return "Something went wrong. Check your tasks before asking again.";
      default: return restartFailure;
    }
  }

  private async statusText(proposal: TaskProposalRecord, replaced = false): Promise<string> {
    if (proposal.state === "pending") return this.pendingText(proposal);
    const subject = await this.subject(proposal);
    if (proposal.state === "confirming") {
      return `${proposal.kind === "create" ? "Creating…" : proposal.kind === "edit" ? "Saving…" : "Working…"} ${subject}`;
    }
    if (proposal.state === "cancelled") return `Cancelled. Nothing was changed. (${subject})`;
    if (proposal.state === "expired") return replaced ? `Replaced by a newer card. (${subject})` : `Expired. Nothing was changed. (${subject})`;
    if (proposal.state === "failed") return `Failed: ${await this.failureText(proposal)} (${subject})`;
    const taskId = proposal.result_task_id ?? proposal.task_id;
    if (proposal.kind === "create") {
      const task = taskId === null ? undefined : await this.store.getTask(taskId);
      const where = !task || task.conversation_id.startsWith("pending:")
        ? "Its thread opens in the task channel on the first run."
        : `Reports: https://discord.com/channels/${proposal.workspace_id}/${task.conversation_id}`;
      return `Created task #${taskId} ${subject}. ${where}`;
    }
    const done = { edit: "Saved changes to", run: "Run started for", pause: "Paused", resume: "Resumed", cancel: "Cancelled" }[proposal.kind];
    return `${done} ${subject}.${proposal.kind === "run" ? " Results will appear in its thread." : ""}`;
  }
}
