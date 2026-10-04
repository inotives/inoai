/* Test-only compatibility store. Production consumers never import this file. */
import type { DatabaseSync } from "node:sqlite";
import {
  archiveFailureNotice, archiveMessage, archiveResponseChunks, bindAgentSession, claimNextMessage, claimResponseChunk,
  completeMessageWithResponse, createEvent, createMemory, createMemoryReview, createSession, failProcessingMessage,
  failRemainingResponseChunks, failResponseChunk, getSession, listEvents, listMemories, listMessages,
  listPendingResponseChunks, markRuntimeStarted, messagesForMemoryReview, recoverStaleWork, rebindAgentSession,
  resetSession, softDeleteMemory, upsertUser,
} from "../database.js";
import type { OperationalStore, MemoryReviewCommit, MemoryReviewSnapshot } from "../operational-store.js";
import type { Configuration } from "../config.js";
import type { MessageQueueMode, NewAgentResponse, NewEvent, NewMemory, NewMemoryReview, NewMessage, NewSession, NewUser, SessionRecord, UserRecord, MessageRecord, MemoryReviewRecord } from "../database.js";

export function sqliteStore(database: DatabaseSync): OperationalStore {
  const store: OperationalStore = {
    async recoverStaleWork(actor) { recoverStaleWork(database, actor); for (const row of database.prepare("SELECT id FROM messages WHERE direction='user' AND state='failed' AND failure_detail='Runtime outcome uncertain after restart' AND updated_by=? AND deleted_at IS NULL").all(actor ?? "startup-recovery") as Array<{ id: number }>) archiveFailureNotice(database, row.id, "I can't confirm whether that turn completed. I won't replay it automatically. Please check the local archive.", actor ?? "startup-recovery"); },
    async bootstrapOwner(configuration) {
      const row = database.prepare("SELECT * FROM users WHERE role='owner' AND state='active' AND deleted_at IS NULL ORDER BY id LIMIT 1").get() as UserRecord | undefined;
      if (row) return row;
      return upsertUser(database, { transport: "discord", workspace_id: configuration.discordGuildId, external_user_id: configuration.discordOwnerUserId, display_name: null, role: "owner", state: "active" })!;
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
    async confirmResponseChunk(id, externalId, actor = "transport:discord") { return database.prepare("UPDATE messages SET external_message_id=?, delivery_state='confirmed', updated_by=? WHERE id=? AND delivery_state='uncertain'").run(externalId as string, actor as string, id as number).changes === 1; },
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
    async completeMemoryReview(id, recap, actor) { return database.prepare("UPDATE memory_reviews SET state='completed', recap=?, completed_at=unixepoch(), updated_by=? WHERE id=? AND deleted_at IS NULL RETURNING *").get(recap as string, actor as string, id as number) as MemoryReviewRecord | undefined; },
    async messagesForMemoryReview(sessionId) { return messagesForMemoryReview(database, sessionId); },
    async readMemoryReview(sessionId, reviewId): Promise<MemoryReviewSnapshot> {
      const review = reviewId === undefined ? undefined : database.prepare("SELECT * FROM memory_reviews WHERE id=? AND session_id=? AND deleted_at IS NULL").get(reviewId, sessionId) as MemoryReviewRecord | undefined;
      const cursor = (database.prepare("SELECT MAX(through_message_id) AS through FROM memory_reviews WHERE session_id=? AND state='completed' AND deleted_at IS NULL").get(sessionId) as { through: number | null }).through ?? 0;
      const messages = messagesForMemoryReview(database, sessionId);
      const ownerUserIds = (database.prepare("SELECT id FROM users WHERE role='owner' AND deleted_at IS NULL").all() as Array<{ id: number }>).map((row) => row.id);
      const recaps = database.prepare("SELECT id, recap FROM memory_reviews WHERE state='completed' AND recap IS NOT NULL AND deleted_at IS NULL ORDER BY completed_at DESC, id DESC").all() as Array<{ id: number; recap: string }>;
      return { cursor, review, messages, ownerUserIds, memories: listMemories(database), recaps };
    },
    async commitMemoryReview(input: MemoryReviewCommit) {
      const cursor = Number((database.prepare("SELECT MAX(through_message_id) AS through FROM memory_reviews WHERE session_id=? AND state='completed' AND deleted_at IS NULL").get(input.sessionId) as { through: number | null }).through ?? 0);
      if (cursor !== input.cursor) return { state: "stale_range" as const };
      const row = input.reviewId === undefined
        ? createMemoryReview(database, { session_id: input.sessionId, from_message_id: input.fromMessageId, through_message_id: input.throughMessageId }, input.actor)
        : database.prepare("SELECT * FROM memory_reviews WHERE id=? AND session_id=? AND deleted_at IS NULL").get(input.reviewId, input.sessionId) as MemoryReviewRecord | undefined;
      if (!row || row.state === "completed") return { state: "stale_range" as const };
      database.prepare("UPDATE memory_reviews SET through_message_id=?, state='completed', recap=?, completed_at=unixepoch(), updated_by=? WHERE id=?").run(input.throughMessageId, input.recap, input.actor ?? "memory-review", row.id);
      for (const action of input.actions) {
        if (action.memoryId !== undefined) softDeleteMemory(database, action.memoryId, input.actor ?? "memory-review");
        if (action.body !== undefined) createMemory(database, { body: action.body, source_message_id: action.sourceMessageId, created_by_user_id: null, review_id: row.id, origin: "review" }, input.actor ?? "memory-review");
      }
      createEvent(database, { session_id: input.sessionId, message_id: null, event_type: "memory_review_completed", detail: `review=${row.id}; through=${input.throughMessageId}` }, input.actor ?? "memory-review");
      return { state: "completed" as const, reviewId: row.id };
    },
    async listSessions() { return database.prepare("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY id").all() as SessionRecord[]; },
    async chatBusy() { return !!database.prepare("SELECT 1 FROM messages AS message WHERE message.direction='user' AND message.deleted_at IS NULL AND (message.state='processing' OR (message.state='pending' AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id=message.session_id AND sessions.state='active' AND sessions.deleted_at IS NULL))) LIMIT 1").get(); },
    async deriveMemoryReviewRange(sessionId) { const rows = messagesForMemoryReview(database, sessionId); let through: number | undefined; let completed = false; for (const row of rows) { if (row.state === "pending" || row.state === "processing") break; through = row.id; completed ||= row.state === "completed"; } return through !== undefined && completed ? { from: rows[0]!.id, through } : undefined; },
    async listOpenMemoryReviews(sessionId) { return database.prepare("SELECT * FROM memory_reviews WHERE session_id=? AND state IN ('pending','processing','failed') AND deleted_at IS NULL ORDER BY id").all(sessionId) as MemoryReviewRecord[]; },
    async updateMemoryReview(id, values) { const sets: string[] = []; const params: any[] = []; if (values.state !== undefined) { sets.push("state=?"); params.push(values.state); } if (values.attempts !== undefined) { sets.push("attempts=?"); params.push(values.attempts); } if (values.failureDetail !== undefined) { sets.push("failure_detail=?"); params.push(values.failureDetail); } if (values.nextAttemptAt !== undefined) { sets.push("next_attempt_at=?"); params.push(values.nextAttemptAt); } params.push(id); return database.prepare(`UPDATE memory_reviews SET ${sets.join(", ")} WHERE id=? AND deleted_at IS NULL`).run(...params).changes === 1; },
    async retireMemoryReview(id, actor) { return database.prepare("UPDATE memory_reviews SET state='failed', failure_detail='stale_range', deleted_at=unixepoch(), deleted_by=? WHERE id=? AND deleted_at IS NULL").run(actor as string, id as number).changes === 1; },
    async claimDueMemoryReview(now, actor) { const row = database.prepare("SELECT * FROM memory_reviews WHERE state='pending' AND next_attempt_at<=? AND deleted_at IS NULL ORDER BY id LIMIT 1").get(now as number) as MemoryReviewRecord | undefined; if (!row) return undefined; return database.prepare("UPDATE memory_reviews SET state='processing', started_at=?, updated_by=? WHERE id=? AND state='pending' RETURNING *").get(now as number, actor as string, row.id as number) as MemoryReviewRecord | undefined; },
    async close() {},
  };
  return store;
}
