import type {
  EventRecord,
  MemoryRecord,
  MemoryReviewRecord,
  MessageQueueMode,
  MessageRecord,
  NewAgentResponse,
  NewEvent,
  NewMemory,
  NewMemoryReview,
  NewMessage,
  NewSession,
  NewUser,
  SessionRecord,
  UserRecord,
} from "./legacy-database.js";
import type { Configuration } from "../platform/config.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { agentSchemaName } from "../platform/agent-identity.js";
import type { MemoryOperationsStore } from "../application/memory/ports.js";

export type MemoryReviewSnapshot = {
  cursor: number;
  review?: MemoryReviewRecord;
  messages: MessageRecord[];
  ownerUserIds: number[];
  memories: MemoryRecord[];
  recaps: Array<{ id: number; recap: string }>;
};

export type MemoryReviewCommit = {
  sessionId: number;
  cursor: number;
  reviewId?: number;
  fromMessageId: number;
  throughMessageId: number;
  recap: string;
  actions: Array<{ op: "add" | "update" | "delete"; memoryId?: number; body?: string; sourceMessageId: number | null }>;
  ignored: string[];
  counts: { added: number; updated: number; deleted: number };
  actor?: string;
};

type Queryable = Pick<Pool, "query">;

function quoteIdentifier(value: string): string {
  // The schema is derived from the validated Agent Instance ID. Keep this check
  // here as a second line of defence because identifiers cannot be parameters.
  if (!/^agent_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value) || value.length > 63) {
    throw new Error("Invalid Agent Schema name");
  }
  return `"${value}"`;
}

function epoch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalize<T extends QueryResultRow>(row: T): T {
  const copy: Record<string, unknown> = { ...row };
  for (const key of ["created_at", "updated_at", "deleted_at", "ended_at", "started_at", "runtime_started_at", "completed_at", "next_attempt_at"]) {
    if (key in copy) copy[key] = epoch(copy[key]);
  }
  for (const key of ["id", "user_id", "session_id", "message_id", "in_reply_to_message_id", "source_message_id", "created_by_user_id", "review_id", "from_message_id", "through_message_id", "request_message_id", "resolution_message_id", "attempts"]) {
    if (key in copy && copy[key] !== null) copy[key] = Number(copy[key]);
  }
  return copy as T;
}

function rows<T extends QueryResultRow>(result: { rows: T[] }): T[] {
  return result.rows.map(normalize);
}

async function safeQuery<T extends QueryResultRow>(queryable: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  try {
    return rows(await queryable.query<T>(text, values));
  } catch (error) {
    if (process.env.INOAI_DEBUG_DB === "1") console.error(error instanceof Error ? error.message : "database error");
    // Do not surface driver errors because they may include connection details.
    throw new Error("PostgreSQL operation failed");
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new Error("PostgreSQL operation failed");
  }
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("PostgreSQL operation failed");
  } finally {
    client.release();
  }
}

/** Async persistence boundary used by the conversation, review, and Manual Memory layers. */
export interface OperationalStore {
  recoverStaleWork(actor?: string): Promise<void>;
  bootstrapOwner(configuration: Configuration, actor?: string): Promise<UserRecord>;
  upsertUser(user: NewUser, actor?: string): Promise<UserRecord | undefined>;
  findUser(transport: string, workspaceId: string | null, externalUserId: string | null): Promise<UserRecord | undefined>;
  createSession(session: NewSession, actor?: string): Promise<SessionRecord>;
  findSessionByConversation(transport: string, workspaceId: string | null, parentConversationId: string | null, conversationId: string): Promise<SessionRecord | undefined>;
  findSessionByAgentSession(provider: string, agentSessionId: string): Promise<SessionRecord | undefined>;
  getSession(id: number): Promise<SessionRecord | undefined>;
  bindAgentSession(id: number, threadId: string, actor?: string): Promise<SessionRecord>;
  rebindAgentSession(id: number, fromId: string, toId: string, actor: string): Promise<SessionRecord>;
  archiveMessage(message: NewMessage, actor?: string): Promise<{ message?: MessageRecord; inserted: boolean }>;
  listMessages(sessionId: number): Promise<MessageRecord[]>;
  claimNextMessage(mode: MessageQueueMode, actor?: string): Promise<MessageRecord | undefined>;
  markRuntimeStarted(messageId: number, actor?: string): Promise<boolean>;
  failProcessingMessage(messageId: number, detail: string, actor?: string): Promise<boolean>;
  archiveResponseChunks(messageId: number, bodies: string[], actor?: string): Promise<MessageRecord[] | undefined>;
  archiveFailureNotice(messageId: number, body: string, actor?: string): Promise<MessageRecord | undefined>;
  listPendingResponseChunks(): Promise<MessageRecord[]>;
  claimResponseChunk(id: number, actor?: string): Promise<boolean>;
  confirmResponseChunk(id: number, externalMessageId: string, actor?: string): Promise<boolean>;
  failResponseChunk(id: number, detail: string, actor?: string): Promise<boolean>;
  failRemainingResponseChunks(inboundMessageId: number, actor?: string): Promise<number>;
  resetSession(sessionId: number, actor?: string): Promise<boolean>;
  completeMessageWithResponse(messageId: number, response: NewAgentResponse, actor?: string): Promise<{ message: MessageRecord; response: MessageRecord } | undefined>;
  createEvent(event: NewEvent, actor?: string): Promise<EventRecord>;
  listEvents(sessionId?: number): Promise<EventRecord[]>;
  listSessions(): Promise<SessionRecord[]>;
  chatBusy(): Promise<boolean>;
  deriveMemoryReviewRange(sessionId: number): Promise<{ from: number; through: number } | undefined>;
  listOpenMemoryReviews(sessionId: number): Promise<MemoryReviewRecord[]>;
  updateMemoryReview(id: number, values: { state?: string; attempts?: number; failureDetail?: string | null; nextAttemptAt?: number | null }, actor?: string): Promise<boolean>;
  retireMemoryReview(id: number, actor?: string): Promise<boolean>;
  claimDueMemoryReview(now: number, actor?: string): Promise<MemoryReviewRecord | undefined>;
  createMemory(memory: NewMemory, actor?: string): Promise<MemoryRecord>;
  listMemories(): Promise<MemoryRecord[]>;
  softDeleteMemory(id: number, actor?: string): Promise<void>;
  createMemoryReview(review: NewMemoryReview, actor?: string): Promise<MemoryReviewRecord>;
  completeMemoryReview(id: number, recap: string, actor?: string): Promise<MemoryReviewRecord | undefined>;
  messagesForMemoryReview(sessionId: number): Promise<MessageRecord[]>;
  readMemoryReview(sessionId: number, reviewId?: number): Promise<MemoryReviewSnapshot>;
  commitMemoryReview(input: MemoryReviewCommit): Promise<{ state: "completed"; reviewId: number } | { state: "stale_range" }>;
  close(): Promise<void>;
}

/** PostgreSQL implementation of the operational persistence boundary.
 *
 * The schema is selected once from AGENT_INSTANCE_ID by the caller. This is
 * application-enforced isolation: the shared runtime role has DML access to
 * provisioned schemas, so every operation must use this instance's schema.
 */
export class PostgresOperationalStore implements OperationalStore, MemoryOperationsStore {
  private readonly schema: string;

  constructor(private readonly pool: Pool, agentInstanceId: string) {
    this.schema = quoteIdentifier(agentSchemaName(agentInstanceId));
  }

  private table(name: string): string {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid operational table name");
    return `${this.schema}."${name}"`;
  }

  async recoverStaleWork(actor = "startup-recovery"): Promise<void> {
    await transaction(this.pool, async (client) => {
      await safeQuery(client, `UPDATE ${this.table("messages")} SET state = 'failed', failure_detail = 'Runtime outcome uncertain after restart', completed_at = now(), updated_at = now(), updated_by = $1 WHERE direction = 'user' AND state = 'processing' AND runtime_started_at IS NOT NULL AND deleted_at IS NULL`, [actor]);
      await safeQuery(client, `UPDATE ${this.table("messages")} SET state = 'pending', updated_at = now(), updated_by = $1 WHERE direction = 'user' AND state = 'processing' AND runtime_started_at IS NULL AND deleted_at IS NULL`, [actor]);
      await safeQuery(client, `UPDATE ${this.table("memory_reviews")} SET state = 'pending', updated_at = now(), updated_by = $1 WHERE state = 'processing' AND deleted_at IS NULL`, [actor]);
    });
  }

  async bootstrapOwner(configuration: Configuration, actor = "owner-bootstrap"): Promise<UserRecord> {
    return transaction(this.pool, async (client) => {
      const owner = await this.upsertUserWith(client, {
        transport: "discord", workspace_id: configuration.discordGuildId,
        external_user_id: configuration.discordOwnerUserId, display_name: null, role: "owner", state: "active",
      }, actor);
      await safeQuery(client, `UPDATE ${this.table("users")} SET state = 'disabled', updated_at = now(), updated_by = $1 WHERE transport = 'discord' AND workspace_id = $2 AND role = 'owner' AND state = 'active' AND deleted_at IS NULL AND external_user_id <> $3`, [actor, configuration.discordGuildId, configuration.discordOwnerUserId]);
      return owner;
    });
  }

  async upsertUser(user: NewUser, actor = "system"): Promise<UserRecord | undefined> {
    return this.upsertUserWith(this.pool, user, actor);
  }

  async findUser(transport: string, workspaceId: string | null, externalUserId: string | null): Promise<UserRecord | undefined> {
    const result = await safeQuery<UserRecord>(this.pool, `SELECT * FROM ${this.table("users")} WHERE transport = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND external_user_id IS NOT DISTINCT FROM $3 AND state = 'active' AND deleted_at IS NULL LIMIT 1`, [transport, workspaceId, externalUserId]);
    return result[0] ? normalize(result[0]) : undefined;
  }

  private async upsertUserWith(queryable: Queryable, user: NewUser, actor: string): Promise<UserRecord> {
    const result = await safeQuery<UserRecord>(queryable, `INSERT INTO ${this.table("users")} (transport, workspace_id, external_user_id, display_name, role, state, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (transport, workspace_id, external_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, state = EXCLUDED.state, deleted_at = NULL, deleted_by = NULL, updated_at = now(), updated_by = EXCLUDED.updated_by RETURNING *`, [user.transport, user.workspace_id, user.external_user_id, user.display_name, user.role, user.state, actor]);
    return normalize(result[0]!);
  }

  async createSession(session: NewSession, actor = "system"): Promise<SessionRecord> {
    const result = await safeQuery<SessionRecord>(this.pool, `INSERT INTO ${this.table("sessions")} (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id, agent_provider, agent_session_id, project_path, state, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [session.user_id, session.transport, session.workspace_id, session.parent_conversation_id, session.conversation_id, session.initiating_external_message_id, session.agent_provider, session.agent_session_id, session.project_path, session.state ?? "active", actor]);
    return normalize(result[0]!);
  }

  async getSession(id: number): Promise<SessionRecord | undefined> {
    const result = await safeQuery<SessionRecord>(this.pool, `SELECT * FROM ${this.table("sessions")} WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return result[0] ? normalize(result[0]) : undefined;
  }

  async findSessionByConversation(transport: string, workspaceId: string | null, parentConversationId: string | null, conversationId: string): Promise<SessionRecord | undefined> {
    const result = await safeQuery<SessionRecord>(this.pool, `SELECT * FROM ${this.table("sessions")} WHERE transport = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND parent_conversation_id IS NOT DISTINCT FROM $3 AND conversation_id = $4 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [transport, workspaceId, parentConversationId, conversationId]);
    return result[0] ? normalize(result[0]) : undefined;
  }

  async findSessionByAgentSession(provider: string, agentSessionId: string): Promise<SessionRecord | undefined> {
    const result = await safeQuery<SessionRecord>(this.pool, `SELECT * FROM ${this.table("sessions")} WHERE agent_provider = $1 AND agent_session_id = $2 AND state = 'active' AND deleted_at IS NULL LIMIT 1`, [provider, agentSessionId]);
    return result[0] ? normalize(result[0]) : undefined;
  }

  async bindAgentSession(id: number, threadId: string, actor = "runtime:codex"): Promise<SessionRecord> {
    if (!threadId || threadId.startsWith("pending:")) throw new Error("Invalid Agent Session ID");
    const result = await safeQuery<SessionRecord>(this.pool, `UPDATE ${this.table("sessions")} SET agent_session_id = $1, updated_at = now(), updated_by = $2 WHERE id = $3 AND agent_session_id LIKE 'pending:%' AND state = 'active' AND deleted_at IS NULL RETURNING *`, [threadId, actor, id]);
    if (!result[0]) throw new Error("Agent Session is no longer pending");
    return normalize(result[0]);
  }

  async rebindAgentSession(id: number, fromId: string, toId: string, actor: string): Promise<SessionRecord> {
    if (!toId || toId.startsWith("pending:")) throw new Error("Invalid Agent Session ID");
    const result = await safeQuery<SessionRecord>(this.pool, `UPDATE ${this.table("sessions")} SET agent_session_id = $1, updated_at = now(), updated_by = $2 WHERE id = $3 AND agent_session_id = $4 AND agent_session_id NOT LIKE 'pending:%' AND state = 'active' AND deleted_at IS NULL RETURNING *`, [toId, actor, id, fromId]);
    if (!result[0]) throw new Error("Agent Session changed before rebinding");
    return normalize(result[0]);
  }

  async archiveMessage(message: NewMessage, actor = "system"): Promise<{ message?: MessageRecord; inserted: boolean }> {
    if (!message.external_message_id) throw new RangeError("External message ID is required");
    const inserted = await safeQuery<MessageRecord>(this.pool, `INSERT INTO ${this.table("messages")} (session_id, transport, workspace_id, external_message_id, external_author_id, user_id, direction, body, reply_to_external_message_id, in_reply_to_message_id, state, failure_detail, completed_at, delivery_state, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $7 = 'user' AND NOT EXISTS (SELECT 1 FROM ${this.table("sessions")} WHERE id = $1 AND state = 'active' AND deleted_at IS NULL) THEN 'failed' ELSE $11 END, CASE WHEN $7 = 'user' AND NOT EXISTS (SELECT 1 FROM ${this.table("sessions")} WHERE id = $1 AND state = 'active' AND deleted_at IS NULL) THEN 'Cancelled by reset before runtime start' ELSE NULL END, CASE WHEN $7 = 'user' AND NOT EXISTS (SELECT 1 FROM ${this.table("sessions")} WHERE id = $1 AND state = 'active' AND deleted_at IS NULL) THEN now() ELSE NULL END, CASE WHEN $7 = 'agent' THEN 'confirmed' ELSE NULL END, $12, $12) ON CONFLICT (transport, workspace_id, external_message_id) DO NOTHING RETURNING *`, [message.session_id, message.transport, message.workspace_id, message.external_message_id, message.external_author_id, message.user_id, message.direction, message.body, message.reply_to_external_message_id, message.in_reply_to_message_id, message.state ?? "pending", actor]);
    const existing = inserted[0] ?? (await safeQuery<MessageRecord>(this.pool, `SELECT * FROM ${this.table("messages")} WHERE transport = $1 AND workspace_id = $2 AND external_message_id = $3 AND deleted_at IS NULL`, [message.transport, message.workspace_id, message.external_message_id]))[0];
    return { message: existing ? normalize(existing) : undefined, inserted: inserted.length === 1 };
  }

  async listMessages(sessionId: number): Promise<MessageRecord[]> {
    return (await safeQuery<MessageRecord>(this.pool, `SELECT * FROM ${this.table("messages")} WHERE session_id = $1 AND deleted_at IS NULL ORDER BY id`, [sessionId])).map(normalize);
  }

  async claimNextMessage(mode: MessageQueueMode, actor = "system"): Promise<MessageRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const result = await safeQuery<MessageRecord>(client, `SELECT candidate.* FROM ${this.table("messages")} candidate WHERE candidate.direction = 'user' AND candidate.state = 'pending' AND candidate.deleted_at IS NULL AND EXISTS (SELECT 1 FROM ${this.table("sessions")} s WHERE s.id = candidate.session_id AND s.state = 'active' AND s.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM ${this.table("messages")} processing WHERE processing.session_id = candidate.session_id AND processing.direction = 'user' AND processing.state = 'processing' AND processing.deleted_at IS NULL) AND ($1 = 'per-session' OR NOT EXISTS (SELECT 1 FROM ${this.table("messages")} processing WHERE processing.direction = 'user' AND processing.state = 'processing' AND processing.deleted_at IS NULL)) ORDER BY candidate.id LIMIT 1 FOR UPDATE SKIP LOCKED`, [mode]);
      const candidate = result[0];
      if (!candidate) return undefined;
      const claimed = await safeQuery<MessageRecord>(client, `UPDATE ${this.table("messages")} SET state = 'processing', started_at = now(), updated_at = now(), updated_by = $1 WHERE id = $2 AND state = 'pending' AND deleted_at IS NULL RETURNING *`, [actor, candidate.id]);
      return claimed[0] ? normalize(claimed[0]) : undefined;
    });
  }

  async markRuntimeStarted(messageId: number, actor = "runtime:codex"): Promise<boolean> {
    return this.updateOne(`UPDATE ${this.table("messages")} m SET runtime_started_at = now(), updated_at = now(), updated_by = $1 WHERE id = $2 AND direction = 'user' AND state = 'processing' AND runtime_started_at IS NULL AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM ${this.table("sessions")} s WHERE s.id = m.session_id AND s.state = 'active' AND s.deleted_at IS NULL)`, [actor, messageId]);
  }

  async failProcessingMessage(messageId: number, detail: string, actor = "system"): Promise<boolean> {
    return this.updateOne(`UPDATE ${this.table("messages")} SET state = 'failed', failure_detail = $1, completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $3 AND direction = 'user' AND state = 'processing' AND deleted_at IS NULL`, [detail, actor, messageId]);
  }

  private async updateOne(sql: string, values: unknown[]): Promise<boolean> {
    try { const result = await this.pool.query(sql, values); return result.rowCount === 1; } catch { throw new Error("PostgreSQL operation failed"); }
  }

  async archiveResponseChunks(messageId: number, bodies: string[], actor = "runtime:codex"): Promise<MessageRecord[] | undefined> {
    if (!bodies.length || bodies.some((body) => !body)) throw new RangeError("Response chunks must be nonempty");
    return transaction(this.pool, async (client) => {
      const inbound = (await safeQuery<MessageRecord>(client, `SELECT * FROM ${this.table("messages")} WHERE id = $1 AND direction = 'user' AND state = 'processing' AND runtime_started_at IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, [messageId]))[0];
      if (!inbound) return undefined;
      const result: MessageRecord[] = [];
      for (const body of bodies) {
        const row = (await safeQuery<MessageRecord>(client, `INSERT INTO ${this.table("messages")} (session_id, transport, workspace_id, direction, body, in_reply_to_message_id, state, provisional_id, delivery_state, created_by, updated_by) VALUES ($1,$2,$3,'agent',$4,$5,'completed',$6,'pending',$7,$7) RETURNING *`, [inbound.session_id, inbound.transport, inbound.workspace_id, body, messageId, randomUUID(), actor]))[0]!;
        result.push(normalize(row));
      }
      await safeQuery(client, `UPDATE ${this.table("messages")} SET state = 'completed', completed_at = now(), updated_at = now(), updated_by = $1 WHERE id = $2 AND state = 'processing'`, [actor, messageId]);
      return result;
    });
  }

  async archiveFailureNotice(messageId: number, body: string, actor = "conversation-worker"): Promise<MessageRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const inbound = (await safeQuery<MessageRecord>(client, `SELECT * FROM ${this.table("messages")} WHERE id = $1 AND direction = 'user' AND state = 'failed' AND deleted_at IS NULL FOR UPDATE`, [messageId]))[0];
      if (!inbound || (await safeQuery(client, `SELECT id FROM ${this.table("messages")} WHERE in_reply_to_message_id = $1 AND direction = 'agent' AND deleted_at IS NULL LIMIT 1`, [messageId])).length) return undefined;
      const row = (await safeQuery<MessageRecord>(client, `INSERT INTO ${this.table("messages")} (session_id, transport, workspace_id, direction, body, in_reply_to_message_id, state, provisional_id, delivery_state, created_by, updated_by) VALUES ($1,$2,$3,'agent',$4,$5,'completed',$6,'pending',$7,$7) RETURNING *`, [inbound.session_id, inbound.transport, inbound.workspace_id, body, messageId, randomUUID(), actor]))[0];
      return row ? normalize(row) : undefined;
    });
  }

  async listPendingResponseChunks(): Promise<MessageRecord[]> { return (await safeQuery<MessageRecord>(this.pool, `SELECT * FROM ${this.table("messages")} WHERE direction = 'agent' AND delivery_state = 'pending' AND in_reply_to_message_id IS NOT NULL AND deleted_at IS NULL ORDER BY id`)).map(normalize); }
  async claimResponseChunk(id: number, actor = "transport:discord"): Promise<boolean> { return this.updateOne(`UPDATE ${this.table("messages")} SET delivery_state = 'uncertain', updated_at = now(), updated_by = $1 WHERE id = $2 AND direction = 'agent' AND delivery_state = 'pending' AND deleted_at IS NULL`, [actor, id]); }
  async confirmResponseChunk(id: number, externalMessageId: string, actor = "transport:discord"): Promise<boolean> { if (!externalMessageId) throw new RangeError("Discord message ID is required"); return this.updateOne(`UPDATE ${this.table("messages")} SET external_message_id = $1, delivery_state = 'confirmed', updated_at = now(), updated_by = $2 WHERE id = $3 AND direction = 'agent' AND delivery_state = 'uncertain' AND deleted_at IS NULL`, [externalMessageId, actor, id]); }
  async failResponseChunk(id: number, detail: string, actor = "transport:discord"): Promise<boolean> { return this.updateOne(`UPDATE ${this.table("messages")} SET delivery_state = 'failed', failure_detail = $1, updated_at = now(), updated_by = $2 WHERE id = $3 AND direction = 'agent' AND delivery_state = 'uncertain' AND deleted_at IS NULL`, [detail, actor, id]); }
  async failRemainingResponseChunks(inboundMessageId: number, actor = "transport:discord"): Promise<number> {
    try { const result = await this.pool.query(`UPDATE ${this.table("messages")} SET delivery_state = 'failed', failure_detail = 'Skipped after earlier chunk was not confirmed', updated_at = now(), updated_by = $1 WHERE direction = 'agent' AND in_reply_to_message_id = $2 AND delivery_state = 'pending' AND deleted_at IS NULL`, [actor, inboundMessageId]); return result.rowCount ?? 0; } catch { throw new Error("PostgreSQL operation failed"); }
  }

  async resetSession(sessionId: number, actor = "user:owner"): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const changed = await this.updateOneWith(client, `UPDATE ${this.table("sessions")} SET state = 'ended', ended_at = now(), updated_at = now(), updated_by = $1 WHERE id = $2 AND state = 'active' AND deleted_at IS NULL`, [actor, sessionId]);
      if (!changed) return false;
      await safeQuery(client, `UPDATE ${this.table("messages")} SET state = 'failed', failure_detail = CASE WHEN runtime_started_at IS NULL THEN 'Cancelled by reset before runtime start' ELSE 'Runtime outcome uncertain after reset' END, completed_at = now(), updated_at = now(), updated_by = $1 WHERE session_id = $2 AND direction = 'user' AND state IN ('pending','processing') AND deleted_at IS NULL`, [actor, sessionId]);
      await safeQuery(client, `UPDATE ${this.table("messages")} SET delivery_state = 'failed', failure_detail = 'Delivery cancelled by reset', updated_at = now(), updated_by = $1 WHERE session_id = $2 AND direction = 'agent' AND delivery_state = 'pending' AND deleted_at IS NULL`, [actor, sessionId]);
      return true;
    });
  }

  private async updateOneWith(client: PoolClient, sql: string, values: unknown[]): Promise<boolean> {
    const result = await client.query(sql, values);
    return result.rowCount === 1;
  }

  async completeMessageWithResponse(messageId: number, response: NewAgentResponse, actor = "system"): Promise<{ message: MessageRecord; response: MessageRecord } | undefined> {
    if (!response.external_message_id) throw new RangeError("Delivered response ID is required");
    return transaction(this.pool, async (client) => {
      const message = (await safeQuery<MessageRecord>(client, `SELECT * FROM ${this.table("messages")} WHERE id = $1 AND direction = 'user' AND state = 'processing' AND deleted_at IS NULL FOR UPDATE`, [messageId]))[0];
      if (!message) return undefined;
      const agentResponse = (await safeQuery<MessageRecord>(client, `INSERT INTO ${this.table("messages")} (session_id, transport, workspace_id, external_message_id, external_author_id, user_id, direction, body, reply_to_external_message_id, in_reply_to_message_id, state, delivery_state, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,'agent',$7,$8,$9,'completed','confirmed',$10,$10) RETURNING *`, [message.session_id, response.transport, response.workspace_id, response.external_message_id, response.external_author_id, response.user_id, response.body, response.reply_to_external_message_id, message.id, actor]))[0]!;
      const completed = (await safeQuery<MessageRecord>(client, `UPDATE ${this.table("messages")} SET state = 'completed', completed_at = now(), updated_at = now(), updated_by = $1 WHERE id = $2 AND state = 'processing' AND deleted_at IS NULL RETURNING *`, [actor, messageId]))[0]!;
      return { message: normalize(completed), response: normalize(agentResponse) };
    });
  }

  async createEvent(event: NewEvent, actor = "system"): Promise<EventRecord> { const row = (await safeQuery<EventRecord>(this.pool, `INSERT INTO ${this.table("events")} (session_id,message_id,event_type,detail,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`, [event.session_id, event.message_id, event.event_type, event.detail, actor]))[0]!; return normalize(row); }
  async listEvents(sessionId?: number): Promise<EventRecord[]> { return (await safeQuery<EventRecord>(this.pool, `SELECT * FROM ${this.table("events")} WHERE deleted_at IS NULL ${sessionId === undefined ? "" : "AND session_id = $1"} ORDER BY id`, sessionId === undefined ? [] : [sessionId])).map(normalize); }
  async listSessions(): Promise<SessionRecord[]> { return (await safeQuery<SessionRecord>(this.pool, `SELECT * FROM ${this.table("sessions")} WHERE deleted_at IS NULL ORDER BY id`)).map(normalize); }
  async chatBusy(): Promise<boolean> { const rows = await safeQuery(this.pool, `SELECT 1 FROM ${this.table("messages")} message WHERE message.direction = 'user' AND message.deleted_at IS NULL AND (message.state = 'processing' OR (message.state = 'pending' AND EXISTS (SELECT 1 FROM ${this.table("sessions")} session WHERE session.id = message.session_id AND session.state = 'active' AND session.deleted_at IS NULL))) LIMIT 1`); return rows.length > 0; }
  async deriveMemoryReviewRange(sessionId: number): Promise<{ from: number; through: number } | undefined> {
    const messages = await safeQuery<{ id: number; state: string }>(this.pool, `SELECT id, state FROM ${this.table("messages")} WHERE session_id = $1 AND id > COALESCE((SELECT MAX(through_message_id) FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL), 0) AND deleted_at IS NULL ORDER BY id`, [sessionId]);
    let through: number | undefined; let completed = false;
    for (const message of messages) { if (message.state === "pending" || message.state === "processing") break; through = Number(message.id); completed ||= message.state === "completed"; }
    return through !== undefined && completed && messages.length ? { from: Number(messages[0].id), through } : undefined;
  }
  async listOpenMemoryReviews(sessionId: number): Promise<MemoryReviewRecord[]> { return (await safeQuery<MemoryReviewRecord>(this.pool, `SELECT * FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state IN ('pending','processing','failed') AND deleted_at IS NULL ORDER BY id`, [sessionId])).map(normalize); }
  async updateMemoryReview(id: number, values: { state?: string; attempts?: number; failureDetail?: string | null; nextAttemptAt?: number | null }, actor = "memory-review-scheduler"): Promise<boolean> {
    const sets: string[] = []; const params: unknown[] = [];
    if (values.state !== undefined) { params.push(values.state); sets.push(`state = $${params.length}`); }
    if (values.attempts !== undefined) { params.push(values.attempts); sets.push(`attempts = $${params.length}`); }
    if (values.failureDetail !== undefined) { params.push(values.failureDetail); sets.push(`failure_detail = $${params.length}`); }
    if (values.nextAttemptAt !== undefined) { params.push(values.nextAttemptAt); sets.push(`next_attempt_at = to_timestamp($${params.length})`); }
    if (!sets.length) return false; params.push(actor); params.push(id);
    return this.updateOne(`UPDATE ${this.table("memory_reviews")} SET ${sets.join(", ")}, updated_at = now(), updated_by = $${params.length - 1} WHERE id = $${params.length} AND state = 'processing' AND deleted_at IS NULL`, params);
  }
  async retireMemoryReview(id: number, actor = "memory-review-scheduler"): Promise<boolean> { return this.updateOne(`UPDATE ${this.table("memory_reviews")} SET state = 'failed', failure_detail = 'stale_range', updated_at = now(), updated_by = $1, deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL`, [actor, id]); }
  async claimDueMemoryReview(now: number, actor = "memory-review-scheduler"): Promise<MemoryReviewRecord | undefined> { return transaction(this.pool, async (client) => { const row = (await safeQuery<MemoryReviewRecord>(client, `SELECT * FROM ${this.table("memory_reviews")} WHERE state = 'pending' AND next_attempt_at <= to_timestamp($1) AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]))[0]; if (!row) return undefined; const claimed = (await safeQuery<MemoryReviewRecord>(client, `UPDATE ${this.table("memory_reviews")} SET state = 'processing', started_at = to_timestamp($1), updated_at = now(), updated_by = $2 WHERE id = $3 AND state = 'pending' AND deleted_at IS NULL RETURNING *`, [now, actor, row.id]))[0]; return claimed ? normalize(claimed) : undefined; }); }
  async createMemory(memory: NewMemory, actor = "system"): Promise<MemoryRecord> { const row = (await safeQuery<MemoryRecord>(this.pool, `INSERT INTO ${this.table("memories")} (body,source_message_id,created_by_user_id,review_id,origin,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [memory.body, memory.source_message_id, memory.created_by_user_id, memory.review_id, memory.origin, actor]))[0]!; return normalize(row); }
  async listMemories(): Promise<MemoryRecord[]> { return (await safeQuery<MemoryRecord>(this.pool, `SELECT * FROM ${this.table("memories")} WHERE state = 'active' AND deleted_at IS NULL ORDER BY id`)).map(normalize); }
  async softDeleteMemory(id: number, actor = "system"): Promise<void> { await safeQuery(this.pool, `UPDATE ${this.table("memories")} SET state = 'deleted', updated_at = now(), updated_by = $1, deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL`, [actor, id]); }
  async createMemoryReview(review: NewMemoryReview, actor = "system"): Promise<MemoryReviewRecord> {
    return transaction(this.pool, async (client) => {
      const boundaries = await safeQuery(client, `SELECT id FROM ${this.table("messages")} WHERE id = ANY($1::bigint[]) AND session_id = $2 AND deleted_at IS NULL`, [[review.from_message_id, review.through_message_id], review.session_id]);
      const cursor = (await safeQuery<{ through_message_id: number }>(client, `SELECT MAX(through_message_id) AS through_message_id FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL`, [review.session_id]))[0]?.through_message_id;
      if (boundaries.length !== 2 || review.from_message_id > review.through_message_id || review.from_message_id <= Number(cursor ?? 0)) throw new RangeError("Memory review boundaries must be active, ordered messages after the completed review cursor");
      const row = (await safeQuery<MemoryReviewRecord>(client, `INSERT INTO ${this.table("memory_reviews")} (session_id,from_message_id,through_message_id,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [review.session_id, review.from_message_id, review.through_message_id, actor]))[0]!;
      return normalize(row);
    });
  }
  async completeMemoryReview(id: number, recap: string, actor = "system"): Promise<MemoryReviewRecord | undefined> { const row = (await safeQuery<MemoryReviewRecord>(this.pool, `UPDATE ${this.table("memory_reviews")} SET state = 'completed', recap = $1, completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $3 AND deleted_at IS NULL RETURNING *`, [recap, actor, id]))[0]; return row ? normalize(row) : undefined; }
  async messagesForMemoryReview(sessionId: number): Promise<MessageRecord[]> { return (await safeQuery<MessageRecord>(this.pool, `SELECT * FROM ${this.table("messages")} WHERE session_id = $1 AND id > COALESCE((SELECT MAX(through_message_id) FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL), 0) AND deleted_at IS NULL ORDER BY id`, [sessionId])).map(normalize); }
  async readMemoryReview(sessionId: number, reviewId?: number): Promise<MemoryReviewSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const reviews = await safeQuery<MemoryReviewRecord>(client, `SELECT * FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND deleted_at IS NULL ${reviewId === undefined ? "" : "AND id = $2"} ORDER BY id`, reviewId === undefined ? [sessionId] : [sessionId, reviewId]);
      const review = reviewId === undefined ? undefined : reviews[0] ? normalize(reviews[0]) : undefined;
      const cursorRow = await safeQuery<{ through_message_id: number | null }>(client, `SELECT MAX(through_message_id) AS through_message_id FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL`, [sessionId]);
      const messages = await safeQuery<MessageRecord>(client, `SELECT * FROM ${this.table("messages")} WHERE session_id = $1 AND id > COALESCE((SELECT MAX(through_message_id) FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL), 0) AND deleted_at IS NULL ORDER BY id`, [sessionId]);
      const owners = await safeQuery<{ id: number }>(client, `SELECT id FROM ${this.table("users")} WHERE role = 'owner' AND deleted_at IS NULL`);
      const memories = await safeQuery<MemoryRecord>(client, `SELECT * FROM ${this.table("memories")} WHERE state = 'active' AND deleted_at IS NULL ORDER BY id`);
      const recaps = await safeQuery<{ id: number; recap: string }>(client, `SELECT id, recap FROM ${this.table("memory_reviews")} WHERE state = 'completed' AND recap IS NOT NULL AND deleted_at IS NULL ORDER BY completed_at DESC, id DESC`);
      await client.query("COMMIT");
      return { cursor: Number(cursorRow[0]?.through_message_id ?? 0), review, messages: messages.map(normalize), ownerUserIds: owners.map((row) => Number(row.id)), memories: memories.map(normalize), recaps: recaps.map(normalize) };
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error("PostgreSQL operation failed");
    } finally {
      client.release();
    }
  }
  async commitMemoryReview(input: MemoryReviewCommit): Promise<{ state: "completed"; reviewId: number } | { state: "stale_range" }> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inoai.memory_review:${input.sessionId}`]);
      const cursorRow = await safeQuery<{ through_message_id: number | null }>(client, `SELECT MAX(through_message_id) AS through_message_id FROM ${this.table("memory_reviews")} WHERE session_id = $1 AND state = 'completed' AND deleted_at IS NULL`, [input.sessionId]);
      if (Number(cursorRow[0]?.through_message_id ?? 0) !== input.cursor) return { state: "stale_range" };
      let review: MemoryReviewRecord | undefined;
      if (input.reviewId !== undefined) {
        review = (await safeQuery<MemoryReviewRecord>(client, `SELECT * FROM ${this.table("memory_reviews")} WHERE id = $1 AND session_id = $2 AND deleted_at IS NULL FOR UPDATE`, [input.reviewId, input.sessionId]))[0];
        if (!review || review.state === "completed") return { state: "stale_range" };
      } else {
        review = (await safeQuery<MemoryReviewRecord>(client, `INSERT INTO ${this.table("memory_reviews")} (session_id,from_message_id,through_message_id,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [input.sessionId, input.fromMessageId, input.throughMessageId, input.actor ?? "memory-review"]))[0];
      }
      if (!review) return { state: "stale_range" };
      const actor = input.actor ?? "memory-review";
      await safeQuery(client, `UPDATE ${this.table("memory_reviews")} SET through_message_id = $1, state = 'completed', recap = $2, completed_at = now(), updated_at = now(), updated_by = $3 WHERE id = $4 AND deleted_at IS NULL`, [input.throughMessageId, input.recap, actor, review.id]);
      for (const action of input.actions) {
        if (action.memoryId !== undefined) await safeQuery(client, `UPDATE ${this.table("memories")} SET state = 'deleted', updated_at = now(), updated_by = $1, deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL`, [actor, action.memoryId]);
        if (action.body !== undefined) await safeQuery(client, `INSERT INTO ${this.table("memories")} (body,source_message_id,created_by_user_id,review_id,origin,created_by,updated_by) VALUES ($1,$2,NULL,$3,'review',$4,$4)`, [action.body, action.sourceMessageId, review.id, actor]);
      }
      const reasons = [...new Set(input.ignored)].sort().map((reason) => `${reason}:${input.ignored.filter((item) => item === reason).length}`).join(",");
      const detail = `review=${review.id}; through=${input.throughMessageId}; added=${input.counts.added}; updated=${input.counts.updated}; deleted=${input.counts.deleted}; ignored=${input.ignored.length}${reasons ? `; reasons=${reasons}` : ""}`;
      await safeQuery(client, `INSERT INTO ${this.table("events")} (session_id,message_id,event_type,detail,created_by,updated_by) VALUES ($1,NULL,'memory_review_completed',$2,$3,$3)`, [input.sessionId, detail, actor]);
      return { state: "completed", reviewId: Number(review.id) };
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}
