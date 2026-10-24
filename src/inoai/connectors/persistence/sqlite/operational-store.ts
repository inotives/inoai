/** Async operational adapter over one initialized SQLite connection.
 * Use openDatabase to retain schema migrations, WAL, and the busy timeout.
 * The adapter owns the connection and closes it during shutdown.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  archiveFailureNotice, archiveMessage, archiveResponseChunks, bindAgentSession, claimNextMessage, claimResponseChunk,
  bindTaskConversation, cancelTask, claimTaskRun, completeTaskRun, createTask, failTaskRun, getTask, getTaskRun, listTaskRuns, listTasks, pauseTask, recoverTaskRuns, resumeTask,
  completeMemoryReview, confirmResponseChunk, completeMessageWithResponse, createEvent, createMemory, createMemoryReview, createSession, failProcessingMessage,
  failRemainingResponseChunks, failResponseChunk, getSession, listEvents, listMemories, listMessages,
  listPendingResponseChunks, markRuntimeStarted, messagesForMemoryReview, recoverStaleWork, rebindAgentSession,
  resetSession, softDeleteMemory, upsertUser, legacyApprovalNotices, claimLegacyApprovalNotice, resolveLegacyApprovalNotice,
  createTaskProposal, expireOverdueTaskProposals, expireSessionTaskProposals, getTaskProposal, resolveTaskProposal, setTaskProposalCardMessage,
  claimTaskProposal, finishTaskProposal, listOpenTaskProposalCards, closeTaskProposalCard, editTask, createPendingTask,
} from "./legacy-database.js";
import type { OperationalStore, MemoryReviewCommit, MemoryReviewSnapshot } from "../../../persistence/operational-store.js";
import type { MemoryOperationsStore } from "../../../memory/ports.js";
import type { MessageQueueMode, NewAgentResponse, NewEvent, NewMemory, NewMemoryReview, NewMessage, NewSession, NewUser, SessionRecord, UserRecord, MemoryReviewRecord, NewTask, TaskRecord, TaskRunRecord, NewTaskProposal, TaskProposalOutcome, TaskProposalRecord, OpenTaskProposalCard, TaskEditResult, PendingTaskOwner } from "./legacy-database.js";
import type { TaskColumns, TaskSpec } from "../../../tasks/schedule.js";

export interface TaskOperationsStore {
  createTask(task: NewTask, actor?: string): Promise<TaskRecord>;
  getTask(id: number): Promise<TaskRecord | undefined>;
  listTasks(): Promise<TaskRecord[]>;
  getTaskRun(id: number): Promise<TaskRunRecord | undefined>;
  listTaskRuns(taskId: number): Promise<TaskRunRecord[]>;
  claimTaskRun(taskId: number, now: number, actor?: string): Promise<TaskRunRecord | undefined>;
  completeTaskRun(runId: number, messageCursor: number, artifactPaths: string[], now: number, actor?: string): Promise<TaskRunRecord>;
  failTaskRun(runId: number, detail: string, now: number, actor?: string): Promise<boolean>;
  pauseTask(taskId: number, actor?: string): Promise<boolean>;
  resumeTask(taskId: number, actor?: string, now?: number): Promise<boolean>;
  cancelTask(taskId: number, now: number, actor?: string): Promise<boolean>;
  bindTaskConversation(taskId: number, binding: { conversationId: string; parentConversationId: string; initiatingExternalMessageId: string }, now: number, actor?: string): Promise<void>;
  recoverTaskRuns(actor?: string, now?: number): Promise<void>;
  createTaskProposal(proposal: NewTaskProposal, now: number, actor?: string): Promise<TaskProposalRecord>;
  getTaskProposal(id: number): Promise<TaskProposalRecord | undefined>;
  setTaskProposalCardMessage(id: number, cardMessageId: string, now: number, actor?: string): Promise<boolean>;
  resolveTaskProposal(id: number, outcome: TaskProposalOutcome, now: number, actor?: string, resultTaskId?: number | null, reason?: string): Promise<{ resolved: boolean; proposal: TaskProposalRecord | undefined }>;
  expireOverdueTaskProposals(now: number, actor?: string): Promise<number>;
  expireSessionTaskProposals(sessionId: number, now: number, actor?: string): Promise<number>;
  claimTaskProposal(id: number, now: number, actor?: string): Promise<{ claimed: boolean; proposal: TaskProposalRecord | undefined }>;
  finishTaskProposal(id: number, outcome: "confirmed" | "failed", now: number, actor?: string, resultTaskId?: number | null, reason?: string): Promise<{ finished: boolean; proposal: TaskProposalRecord | undefined }>;
  listOpenTaskProposalCards(): Promise<OpenTaskProposalCard[]>;
  closeTaskProposalCard(id: number, now: number, actor?: string): Promise<boolean>;
  editTask(taskId: number, spec: TaskSpec, now: number, actor: string): Promise<TaskEditResult>;
  createPendingTask(owner: PendingTaskOwner, columns: TaskColumns, actor: string): Promise<TaskRecord>;
}

export function createSqliteOperationalStore(database: DatabaseSync): OperationalStore & MemoryOperationsStore & TaskOperationsStore {
  function transaction<T>(work: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  const store: OperationalStore & TaskOperationsStore = {
    async legacyApprovalNotices() { return legacyApprovalNotices(database); },
    async createTask(task, actor) { return createTask(database, task, actor); },
    async getTask(id) { return getTask(database, id); },
    async listTasks() { return listTasks(database); },
    async getTaskRun(id) { return getTaskRun(database, id); },
    async listTaskRuns(taskId) { return listTaskRuns(database, taskId); },
    async claimTaskRun(taskId, now, actor) { return claimTaskRun(database, taskId, now, actor); },
    async completeTaskRun(runId, messageCursor, artifactPaths, now, actor) { return completeTaskRun(database, runId, messageCursor, artifactPaths, now, actor); },
    async failTaskRun(runId, detail, now, actor) { return failTaskRun(database, runId, detail, now, actor); },
    async pauseTask(taskId, actor) { return pauseTask(database, taskId, actor); },
    async resumeTask(taskId, actor, now) { return resumeTask(database, taskId, actor, now); },
    async cancelTask(taskId, now, actor) { return cancelTask(database, taskId, now, actor); },
    async bindTaskConversation(taskId, binding, now, actor) { bindTaskConversation(database, taskId, binding, now, actor); },
    async recoverTaskRuns(actor, now) { recoverTaskRuns(database, actor, now); },
    async createTaskProposal(proposal, now, actor) { return createTaskProposal(database, proposal, now, actor); },
    async getTaskProposal(id) { return getTaskProposal(database, id); },
    async setTaskProposalCardMessage(id, cardMessageId, now, actor) { return setTaskProposalCardMessage(database, id, cardMessageId, now, actor); },
    async resolveTaskProposal(id, outcome, now, actor, resultTaskId, reason) { return resolveTaskProposal(database, id, outcome, now, actor, resultTaskId, reason); },
    async expireOverdueTaskProposals(now, actor) { return expireOverdueTaskProposals(database, now, actor); },
    async expireSessionTaskProposals(sessionId, now, actor) { return expireSessionTaskProposals(database, sessionId, now, actor); },
    async claimTaskProposal(id, now, actor) { return claimTaskProposal(database, id, now, actor); },
    async finishTaskProposal(id, outcome, now, actor, resultTaskId, reason) { return finishTaskProposal(database, id, outcome, now, actor, resultTaskId, reason); },
    async listOpenTaskProposalCards() { return listOpenTaskProposalCards(database); },
    async closeTaskProposalCard(id, now, actor) { return closeTaskProposalCard(database, id, now, actor); },
    async editTask(taskId, spec, now, actor) { return editTask(database, taskId, spec, now, actor); },
    async createPendingTask(owner, columns, actor) { return createPendingTask(database, owner, columns, actor); },
    async claimLegacyApprovalNotice(id) { return claimLegacyApprovalNotice(database, id); },
    async resolveLegacyApprovalNotice(id, messageId) { resolveLegacyApprovalNotice(database, id, messageId); },
    async recoverStaleWork(actor = "startup-recovery") {
      recoverStaleWork(database, actor);
      const failed = database.prepare("SELECT id FROM messages WHERE direction='user' AND state='failed' AND failure_detail='Runtime outcome uncertain after restart' AND updated_by=? AND deleted_at IS NULL").all(actor) as Array<{ id: number }>;
      for (const row of failed) {
        archiveFailureNotice(database, row.id, "I can't confirm whether that turn completed. I won't replay it automatically. Please check the local archive.", actor);
      }
    },
    async bootstrapOwner(configuration, actor = "owner-bootstrap") {
      return transaction(() => {
        const owner = upsertUser(database, { transport: "discord", workspace_id: configuration.discordGuildId, external_user_id: configuration.discordOwnerUserId, display_name: null, role: "owner", state: "active" }, actor)!;
        database.prepare("UPDATE users SET state='disabled', updated_at=unixepoch(), updated_by=? WHERE transport='discord' AND workspace_id=? AND role='owner' AND state='active' AND deleted_at IS NULL AND external_user_id<>?").run(actor, configuration.discordGuildId, configuration.discordOwnerUserId);
        return owner;
      });
    },
    async upsertUser(user: NewUser, actor) { return upsertUser(database, user, actor); },
    async findUser(transport, workspaceId, externalUserId) { return database.prepare("SELECT * FROM users WHERE transport=? AND workspace_id IS ? AND external_user_id IS ? AND state='active' AND deleted_at IS NULL LIMIT 1").get(transport, workspaceId, externalUserId) as UserRecord | undefined; },
    async createSession(session: NewSession, actor) { return createSession(database, session, actor); },
    async findSessionByConversation(transport, workspaceId, parentConversationId, conversationId) { return database.prepare("SELECT * FROM sessions WHERE transport=? AND workspace_id IS ? AND parent_conversation_id IS ? AND conversation_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(transport, workspaceId, parentConversationId, conversationId) as SessionRecord | undefined; },
    async findSessionByAgentSession(provider, agentSessionId) { return database.prepare("SELECT * FROM sessions WHERE agent_provider=? AND agent_session_id=? AND state='active' AND deleted_at IS NULL LIMIT 1").get(provider, agentSessionId) as SessionRecord | undefined; },
    async getSession(id) { return getSession(database, id); },
    async bindAgentSession(id, threadId, actor) { return bindAgentSession(database, id, threadId, actor); },
    async rebindAgentSession(id, fromId, toId, actor) { return rebindAgentSession(database, id, fromId, toId, actor); },
    async archiveMessage(message: NewMessage, actor) { return archiveMessage(database, message, actor); },
    async listMessages(sessionId) { return listMessages(database, sessionId); },
    async claimNextMessage(mode: MessageQueueMode, actor) { return claimNextMessage(database, mode, actor); },
    async markRuntimeStarted(id, actor) { return markRuntimeStarted(database, id, actor); },
    async failProcessingMessage(id, detail, actor) { return failProcessingMessage(database, id, detail, actor); },
    async archiveResponseChunks(id, bodies, actor) { return archiveResponseChunks(database, id, bodies, actor); },
    async archiveFailureNotice(id, body, actor) { return archiveFailureNotice(database, id, body, actor); },
    async listPendingResponseChunks() { return listPendingResponseChunks(database); },
    async claimResponseChunk(id, actor) { return claimResponseChunk(database, id, actor); },
    async confirmResponseChunk(id, externalId, actor) { return confirmResponseChunk(database, id, externalId, actor); },
    async failResponseChunk(id, detail, actor) { return failResponseChunk(database, id, detail, actor); },
    async failRemainingResponseChunks(id, actor) { return failRemainingResponseChunks(database, id, actor); },
    async resetSession(id, actor) { return resetSession(database, id, actor); },
    async completeMessageWithResponse(id, response: NewAgentResponse, actor) { return completeMessageWithResponse(database, id, response, actor); },
    async createEvent(event: NewEvent, actor) { return createEvent(database, event, actor); },
    async listEvents(sessionId) { return listEvents(database, sessionId); },
    async createMemory(memory: NewMemory, actor) { return createMemory(database, memory, actor); },
    async listMemories() { return listMemories(database); },
    async softDeleteMemory(id, actor) { softDeleteMemory(database, id, actor); },
    async createMemoryReview(review: NewMemoryReview, actor) { return createMemoryReview(database, review, actor); },
    async completeMemoryReview(id, recap, actor) { return completeMemoryReview(database, id, recap, actor); },
    async messagesForMemoryReview(sessionId) { return messagesForMemoryReview(database, sessionId); },
    async readMemoryReview(sessionId, reviewId): Promise<MemoryReviewSnapshot> {
      return transaction(() => {
        const review = reviewId === undefined ? undefined : database.prepare("SELECT * FROM memory_reviews WHERE id=? AND session_id=? AND deleted_at IS NULL").get(reviewId, sessionId) as MemoryReviewRecord | undefined;
        const cursor = (database.prepare("SELECT MAX(through_message_id) AS through FROM memory_reviews WHERE session_id=? AND state='completed' AND deleted_at IS NULL").get(sessionId) as { through: number | null }).through ?? 0;
        const messages = messagesForMemoryReview(database, sessionId);
        const ownerUserIds = (database.prepare("SELECT id FROM users WHERE role='owner' AND deleted_at IS NULL").all() as Array<{ id: number }>).map((row) => row.id);
        const recaps = database.prepare("SELECT id, recap FROM memory_reviews WHERE state='completed' AND recap IS NOT NULL AND deleted_at IS NULL ORDER BY completed_at DESC, id DESC").all() as Array<{ id: number; recap: string }>;
        return { cursor, review, messages, ownerUserIds, memories: listMemories(database), recaps };
      });
    },
    async commitMemoryReview(input: MemoryReviewCommit) {
      return transaction(() => {
        const cursor = Number((database.prepare("SELECT MAX(through_message_id) AS through FROM memory_reviews WHERE session_id=? AND state='completed' AND deleted_at IS NULL").get(input.sessionId) as { through: number | null }).through ?? 0);
        if (cursor !== input.cursor) return { state: "stale_range" as const };
        const row = input.reviewId === undefined
          ? createMemoryReview(database, { session_id: input.sessionId, from_message_id: input.fromMessageId, through_message_id: input.throughMessageId }, input.actor ?? "memory-review")
          : database.prepare("SELECT * FROM memory_reviews WHERE id=? AND session_id=? AND deleted_at IS NULL").get(input.reviewId, input.sessionId) as MemoryReviewRecord | undefined;
        if (!row || row.state === "completed") return { state: "stale_range" as const };
        database.prepare("UPDATE memory_reviews SET through_message_id=?, state='completed', recap=?, completed_at=unixepoch(), updated_at=unixepoch(), updated_by=? WHERE id=?").run(input.throughMessageId, input.recap, input.actor ?? "memory-review", row.id);
        for (const action of input.actions) {
          if (action.memoryId !== undefined) softDeleteMemory(database, action.memoryId, input.actor ?? "memory-review");
          if (action.body !== undefined) createMemory(database, { body: action.body, source_message_id: action.sourceMessageId, created_by_user_id: null, review_id: row.id, origin: "review" }, input.actor ?? "memory-review");
        }
        const reasons = [...new Set(input.ignored)].sort().map((reason) => `${reason}:${input.ignored.filter((item) => item === reason).length}`).join(",");
        const detail = `review=${row.id}; through=${input.throughMessageId}; added=${input.counts.added}; updated=${input.counts.updated}; deleted=${input.counts.deleted}; ignored=${input.ignored.length}${reasons ? `; reasons=${reasons}` : ""}`;
        createEvent(database, { session_id: input.sessionId, message_id: null, event_type: "memory_review_completed", detail }, input.actor ?? "memory-review");
        return { state: "completed" as const, reviewId: row.id };
      });
    },
    async listSessions() { return database.prepare("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY id").all() as SessionRecord[]; },
    async chatBusy() { return !!database.prepare("SELECT 1 FROM messages AS message WHERE message.direction='user' AND message.deleted_at IS NULL AND (message.state='processing' OR (message.state='pending' AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id=message.session_id AND sessions.state='active' AND sessions.deleted_at IS NULL))) LIMIT 1").get(); },
    async deriveMemoryReviewRange(sessionId) {
      const rows = messagesForMemoryReview(database, sessionId);
      let through: number | undefined;
      let completed = false;
      for (const row of rows) {
        if (row.state === "pending" || row.state === "processing") break;
        through = row.id;
        completed ||= row.state === "completed";
      }
      return through !== undefined && completed ? { from: rows[0]!.id, through } : undefined;
    },
    async listOpenMemoryReviews(sessionId) { return database.prepare("SELECT * FROM memory_reviews WHERE session_id=? AND state IN ('pending','processing','failed') AND deleted_at IS NULL ORDER BY id").all(sessionId) as MemoryReviewRecord[]; },
    async updateMemoryReview(id, values, actor = "memory-review-scheduler") {
      const sets: string[] = [];
      const params: SQLInputValue[] = [];
      if (values.state !== undefined) { sets.push("state=?"); params.push(values.state); }
      if (values.attempts !== undefined) { sets.push("attempts=?"); params.push(values.attempts); }
      if (values.failureDetail !== undefined) { sets.push("failure_detail=?"); params.push(values.failureDetail); }
      if (values.nextAttemptAt !== undefined) { sets.push("next_attempt_at=?"); params.push(values.nextAttemptAt); }
      if (!sets.length) return false;
      sets.push("updated_at=unixepoch()", "updated_by=?");
      params.push(actor, id);
      return database.prepare(`UPDATE memory_reviews SET ${sets.join(", ")} WHERE id=? AND state IN ('pending','processing','failed') AND deleted_at IS NULL`).run(...params).changes === 1;
    },
    async retireMemoryReview(id, actor = "memory-review-scheduler") {
      return database.prepare("UPDATE memory_reviews SET state='failed', failure_detail='stale_range', updated_at=unixepoch(), updated_by=?, deleted_at=unixepoch(), deleted_by=? WHERE id=? AND deleted_at IS NULL").run(actor, actor, id).changes === 1;
    },
    async claimDueMemoryReview(now, actor = "memory-review-scheduler") {
      return transaction(() => {
        const row = database.prepare("SELECT * FROM memory_reviews WHERE state='pending' AND next_attempt_at<=? AND deleted_at IS NULL ORDER BY id LIMIT 1").get(now) as MemoryReviewRecord | undefined;
        if (!row) return undefined;
        return database.prepare("UPDATE memory_reviews SET state='processing', started_at=?, updated_at=unixepoch(), updated_by=? WHERE id=? AND state='pending' AND deleted_at IS NULL RETURNING *").get(now, actor, row.id) as MemoryReviewRecord | undefined;
      });
    },
    async close() { database.close(); },
  };
  return store;
}
