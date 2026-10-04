import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentRuntime } from "./agent-runtime.js";
import { ApprovalRelay, claudePermissionDenialNotifier, openCodePermissionDenialNotifier } from "./approval-relay.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { CodexAppServer } from "./codex-app-server.js";
import { CodexRuntime } from "./codex-runtime.js";
import { probeClaudeConcurrency, probeCodexConcurrency } from "./concurrency-probe.js";
import { loadConfiguration } from "./config.js";
import type { MemoryRecord, UserRecord } from "./database.js";
import { ConversationWorker } from "./conversation-worker.js";
import { classifyIncomingMessage } from "./inbound-policy.js";
import { MemoryReviewScheduler } from "./memory-review-scheduler.js";
import type { SchedulerClock } from "./memory-review-scheduler.js";
import { OpenCodeRuntime } from "./opencode-runtime.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "./runtime-home.js";
import { createChatTransport } from "./transport.js";
import type { ChatTransport, IncomingMessage, ThreadControl } from "./transport.js";
import { launchUi } from "./ui.js";
import type { OperationalStore } from "./operational-store.js";
import { createPostgresPool } from "./postgres.js";
import { PostgresOperationalStore } from "./operational-store.js";
import { acquireAgentInstanceLease } from "./postgres-lease.js";

export const appName = "inoai";
export * from "./config.js";
export * from "./agent-runtime.js";
export * from "./agent-session.js";
export * from "./approval-relay.js";
export * from "./claude-runtime.js";
export * from "./codex-app-server.js";
export * from "./codex-runtime.js";
export * from "./conversation-worker.js";
export * from "./database.js";
export * from "./inbound-policy.js";
export * from "./memory-review.js";
export * from "./memory-review-scheduler.js";
export * from "./postgres-lease.js";
export * from "./runtime-home.js";
export * from "./runtime-turn.js";
export * from "./transport.js";
export * from "./ui.js";

// Owner decision D2: only Claude homes review in V1. The wired Codex runtime never enables its review method, so the
// Memory Review engine skips Codex homes like OpenCode ones.
export function createCodexRuntime(server: CodexAppServer): CodexRuntime {
  return new CodexRuntime(server);
}

export async function validate(launchDirectory = process.cwd(), connectDirectory?: string) {
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const configuration = await loadConfiguration(runtimeHome.envFile);
  return { runtimeHome, configuration };
}

export async function start(launchDirectory = process.cwd(), connectDirectory?: string, storeFactory?: (pool: unknown, runtimeHome: Awaited<ReturnType<typeof validate>>["runtimeHome"]) => OperationalStore) {
  const { runtimeHome, configuration } = await validate(launchDirectory, connectDirectory);
  const release = await acquireRuntimeHomeLock(runtimeHome);
  const pool = createPostgresPool(configuration);
  try {
    const store = storeFactory?.(pool, runtimeHome) ?? new PostgresOperationalStore(pool, configuration.agentInstanceId);
    const owner = await store.bootstrapOwner(configuration);
    // Explicit store injection is the unit-test seam; it supplies its own
    // isolated persistence fixture and does not need a live PostgreSQL lease.
    const lease = storeFactory ? {
      refresh: async () => {},
      release: async () => {},
    } : await acquireAgentInstanceLease(pool, {
      agentInstanceId: configuration.agentInstanceId,
      ttlMs: configuration.postgresLeaseTtlMs,
      refreshMs: configuration.postgresLeaseRefreshMs,
    });
    const pendingIngestion = new Set<Promise<void>>();
    const instance = {
      runtimeHome,
      configuration,
      pool,
      store,
      owner,
      lease,
      pendingIngestion,
      closing: false,
      release: async () => {
        instance.closing = true;
        await Promise.allSettled([...pendingIngestion]);
        await lease.release();
        await store.close();
        await pool.end();
        await release();
      },
    };
    return instance;
  } catch (error) {
    await pool.end().catch(() => undefined);
    await release();
    throw error;
  }
}

export async function startTransport(
  instance: Awaited<ReturnType<typeof start>>,
  onIncomingMessage?: (message: IncomingMessage) => void,
  transport: ChatTransport = createChatTransport(instance.configuration),
  onFailure?: (error: Error) => void,
  worker?: ConversationWorker,
  operationalStore?: OperationalStore,
): Promise<ChatTransport> {
  const store = operationalStore ?? instance.store;
  const inFlight = new Set<string>();
  const receive = onIncomingMessage ?? ((message: IncomingMessage) => { void (async () => {
    if (instance.closing) return;
    const eligible = await classifyIncomingMessage(store, instance.configuration, message);
    const workspaceId = message.workspaceId;
    if (eligible?.kind === "reset-thread" && workspaceId !== null) {
      try {
        const session = await store.createSession({
            user_id: eligible.user.id, transport: message.transport, workspace_id: workspaceId,
            parent_conversation_id: message.parentConversationId!, conversation_id: message.conversationId,
            initiating_external_message_id: message.externalMessageId, agent_provider: instance.configuration.agentProvider,
            agent_session_id: `pending:${message.externalMessageId}`, project_path: dirname(instance.runtimeHome.directory),
          }, "transport:discord");
          const archived = await store.archiveMessage({
            session_id: session.id, transport: message.transport, workspace_id: workspaceId,
            external_message_id: message.externalMessageId, external_author_id: message.externalUserId,
            user_id: eligible.user.id, direction: "user", body: message.body,
            reply_to_external_message_id: message.replyToExternalMessageId, in_reply_to_message_id: null,
          }, "transport:discord");
          if (!archived.inserted) throw new Error("Reset thread message already archived");
          worker?.wake();
      } catch (error) {
        console.error("Discord reset thread message failed:", error instanceof Error ? error.message : error);
      }
      return;
    }
    if (eligible?.kind === "bound-thread" && workspaceId !== null) {
      try {
        const archived = await store.archiveMessage({
          session_id: eligible.session.id, transport: message.transport, workspace_id: workspaceId,
          external_message_id: message.externalMessageId, external_author_id: message.externalUserId,
          user_id: eligible.user.id, direction: "user", body: message.body,
          reply_to_external_message_id: message.replyToExternalMessageId, in_reply_to_message_id: null,
        }, "transport:discord");
        if (archived.inserted) {
          void transport.showWorking?.(message.conversationId).catch(() => undefined);
          worker?.wake();
        }
      } catch (error) {
        console.error("Discord thread message failed:", error instanceof Error ? error.message : error);
      }
      return;
    }
    if (eligible?.kind !== "top-level" || workspaceId === null || inFlight.has(message.externalMessageId)) return;
    inFlight.add(message.externalMessageId);
    try {
      const existing = (await store.listSessions()).some((session) => session.transport === message.transport
        && session.workspace_id === workspaceId && session.initiating_external_message_id === message.externalMessageId);
      if (existing) {
        inFlight.delete(message.externalMessageId);
        return;
      }
    } catch (error) {
      inFlight.delete(message.externalMessageId);
      throw error;
    }
    const pending = (async () => {
      let conversationId: string | undefined;
      try {
        conversationId = await transport.createConversation(
          message.conversationId, message.externalMessageId, message.body.trim().slice(0, 100) || "inoai conversation",
        );
        const session = await store.createSession({
            user_id: eligible.user.id, transport: message.transport, workspace_id: workspaceId,
            parent_conversation_id: message.conversationId, conversation_id: conversationId,
            initiating_external_message_id: message.externalMessageId, agent_provider: instance.configuration.agentProvider,
            agent_session_id: `pending:${message.externalMessageId}`, project_path: dirname(instance.runtimeHome.directory),
          }, "transport:discord");
          const archived = await store.archiveMessage({
            session_id: session.id, transport: message.transport, workspace_id: workspaceId,
            external_message_id: message.externalMessageId, external_author_id: message.externalUserId,
            user_id: eligible.user.id, direction: "user", body: message.body,
            reply_to_external_message_id: message.replyToExternalMessageId, in_reply_to_message_id: null,
          }, "transport:discord");
          if (!archived.inserted) throw new Error("Initiating Discord message already archived");
          void transport.showWorking?.(conversationId).catch(() => undefined);
          worker?.wake();
      } catch (error) {
        if (conversationId) {
          try {
            await transport.deleteConversation(conversationId);
          } catch (cleanupError) {
            console.error("Discord thread cleanup failed:", cleanupError instanceof Error ? cleanupError.message : cleanupError);
          }
        }
        console.error("Discord request failed:", error instanceof Error ? error.message : error);
      } finally {
        inFlight.delete(message.externalMessageId);
      }
    })();
    instance.pendingIngestion.add(pending);
    void pending.finally(() => instance.pendingIngestion.delete(pending));
  })().catch((error: unknown) => console.error("Discord message handling failed:", error instanceof Error ? error.message : error)); });
  const control = async (request: ThreadControl) => {
    const denied = "This control is available only in your active inoai thread.";
    if (instance.closing || request.workspaceId !== instance.configuration.discordGuildId
      || request.externalUserId !== instance.configuration.discordOwnerUserId || !request.parentConversationId
      || request.parentConversationId === instance.configuration.discordStatusChannelId) {
      await request.respond(denied);
      return;
    }
    const owner = await store.findUser("discord", request.workspaceId, request.externalUserId);
    const session = owner ? await store.findSessionByConversation(
      "discord", request.workspaceId, request.parentConversationId, request.conversationId,
    ) : undefined;
    if (session && session.user_id !== owner?.id) {
      await request.respond(request.conversationOwnedByBot ? denied
        : "This thread belongs to another inoai bot. Choose that bot's /inoai command to control it.");
      return;
    }
    if (!session) {
      await request.respond(request.conversationOwnedByBot ? denied
        : "This thread belongs to another inoai bot. Choose that bot's /inoai command to control it.");
      return;
    }
    if (request.command === "status") {
      const messages = await store.listMessages(session.id);
      const counts = {
        queued: messages.filter((message) => message.direction === "user" && message.state === "pending").length,
        running: messages.filter((message) => message.direction === "user" && message.state === "processing").length,
        failed: messages.filter((message) => message.direction === "user" && message.state === "failed").length,
        uncertain_delivery: messages.filter((message) => message.direction === "agent" && message.delivery_state === "uncertain").length,
      };
      await request.respond(`Project: ${session.project_path}\nSession: ${session.agent_session_id.startsWith("pending:") ? "pending" : "active"}`
        + `\nQueued: ${counts.queued ?? 0}; running: ${counts.running ?? 0}; failed: ${counts.failed ?? 0}; uncertain deliveries: ${counts.uncertain_delivery ?? 0}`);
      return;
    }
    if (!worker) { await request.respond("Control unavailable. Please try again."); return; }
    if (request.command === "cancel") {
      const cancelled = await worker.cancelSession(session.id);
      await request.respond(cancelled ? "Cancellation requested for this thread's active turn. Queued work remains." : "No active turn to cancel. Queued work remains.");
      return;
    }
    const cancelling = worker.cancelSession(session.id);
    if (!await store.resetSession(session.id)) { await cancelling; await request.respond(denied); return; }
    await cancelling;
    await request.respond("Session reset. Queued work was cancelled; archived history remains. The next message starts a fresh session. Active work may have an uncertain outcome.");
  };
  try {
    await transport.start(receive, async () => {
      if (transport.health().state !== "ready") throw new Error("Discord disconnected before startup announcement");
      await transport.registerThreadControls?.(instance.configuration.discordGuildId);
      const messageId = await transport.publishHealth(instance.configuration.discordStatusChannelId, "inoai is online", instance.configuration.discordGuildId);
      if (transport.health().state !== "ready") throw new Error("Discord disconnected during startup announcement");
      await store.createEvent({
        session_id: null,
        message_id: null,
        event_type: "startup_online",
        detail: `discord message ${messageId}`,
      }, "transport:discord");
    }, onFailure, control);
    worker?.wake();
    return transport;
  } catch (error) {
    await transport.stop();
    throw error;
  }
}

export function manageMemory(operation: "add", argument: string, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord>;
export function manageMemory(operation: "list", argument: undefined, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord[]>;
export function manageMemory(operation: "delete", argument: string, launchDirectory?: string, connectDirectory?: string): Promise<void>;
export function manageMemory(operation: "add" | "list" | "delete", argument: string | undefined, launchDirectory?: string, connectDirectory?: string): Promise<MemoryRecord | MemoryRecord[] | void>;
export async function manageMemory(
  operation: "add" | "list" | "delete",
  argument: string | undefined,
  launchDirectory = process.cwd(),
  connectDirectory?: string,
): Promise<MemoryRecord | MemoryRecord[] | void> {
  const { configuration } = await validate(launchDirectory, connectDirectory);
  const pool = createPostgresPool(configuration);
  const store = new PostgresOperationalStore(pool, configuration.agentInstanceId);
  try {
    const owner = await store.bootstrapOwner(configuration);
    const actor = `manual-cli:user:${owner.id}`;
    if (operation === "list") return store.listMemories();
    if (operation === "add") {
      const body = argument?.trim();
      if (!body) throw new Error("Usage: inoai memory add <text>");
      return store.createMemory({
        body,
        source_message_id: null,
        created_by_user_id: owner.id,
        review_id: null,
        origin: "manual",
      }, actor);
    }
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Usage: inoai memory delete <id>");
    if (!(await store.listMemories()).some((memory) => memory.id === id)) throw new Error(`Manual Memory Entry not found: ${id}`);
    await store.softDeleteMemory(id, actor);
  } finally {
    await store.close();
  }
}

/** Manual Memory operations for the PostgreSQL operational store. This helper is
 * intentionally runtime-free: it never starts an Agent Runtime or transport. */
export async function manageMemoryWithStore(
  store: Pick<OperationalStore, "listMemories" | "createMemory" | "softDeleteMemory">,
  operation: "add" | "list" | "delete",
  argument: string | undefined,
  ownerUserId: number | null = null,
): Promise<MemoryRecord | MemoryRecord[] | void> {
  const actor = ownerUserId === null ? "manual-cli" : `manual-cli:user:${ownerUserId}`;
  if (operation === "list") return store.listMemories();
  if (operation === "add") {
    const body = argument?.trim();
    if (!body) throw new Error("Usage: inoai memory add <text>");
    return store.createMemory({ body, source_message_id: null, created_by_user_id: ownerUserId, review_id: null, origin: "manual" }, actor);
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Usage: inoai memory delete <id>");
  if (!(await store.listMemories()).some((memory) => memory.id === id)) throw new Error(`Manual Memory Entry not found: ${id}`);
  await store.softDeleteMemory(id, actor);
}

type AllowlistStore = Pick<OperationalStore, "findUser" | "upsertUser">;
export type AllowlistOperation = "add" | "disable";

export async function manageAllowlistWithStore(
  store: AllowlistStore,
  operation: AllowlistOperation,
  guildId: string,
  userId: string,
  displayName?: string,
  actor = "allowlist-cli",
): Promise<UserRecord> {
  const existing = await store.findUser("discord", guildId, userId);
  if (existing?.role === "owner") throw new Error("The configured Discord owner cannot be changed by this command");
  if (operation === "add" && !displayName?.trim()) throw new Error("Usage: inoai allowlist:add --user-id <id> --display-name <name>");
  return (await store.upsertUser({
    transport: "discord", workspace_id: guildId, external_user_id: userId,
    display_name: displayName?.trim() || existing?.display_name || null,
    role: "family", state: operation === "add" ? "active" : "disabled",
  }, actor))!;
}

export function parseConnectDirectory(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--connect-dir") return args[1];
  throw new Error("Usage: inoai [--connect-dir .inoai-connect*]");
}

function parseMemoryCommand(args: string[]): { operation: "add" | "list" | "delete"; argument: string | undefined; connectDirectory: string | undefined } {
  const connectDirectory = args.length >= 2 && args.at(-2) === "--connect-dir" ? args.at(-1) : undefined;
  const command = connectDirectory === undefined ? args : args.slice(0, -2);
  const [operation, ...values] = command;
  if ((operation === "add" || operation === "delete") && values.length === 1) return { operation, argument: values[0], connectDirectory };
  if (operation === "list" && values.length === 0) return { operation, argument: undefined, connectDirectory };
  throw new Error("Usage: inoai memory <add <text>|list|delete <id>> [--connect-dir .inoai-connect*]");
}

function parseAllowlistCommand(args: string[]): { operation: AllowlistOperation; userId: string; displayName?: string; connectDirectory?: string } {
  const operation = args[0] === "allowlist:add" ? "add" : args[0] === "allowlist:disable" ? "disable" : undefined;
  const usage = "Usage: inoai allowlist:<add|disable> --user-id <id> [--display-name <name>] [--connect-dir .inoai-connect*]";
  if (!operation) throw new Error(usage);
  const values = args.slice(1);
  let userId: string | undefined;
  let displayName: string | undefined;
  let connectDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--user-id") userId = value;
    else if (flag === "--display-name") displayName = value;
    else if (flag === "--connect-dir") connectDirectory = value;
    else throw new Error(usage);
  }
  if (!userId || !/^\d{1,25}$/.test(userId)) throw new Error("--user-id must be a Discord numeric user ID");
  if (displayName !== undefined && (displayName.trim().length === 0 || displayName.length > 256)) throw new Error("--display-name must be between 1 and 256 characters");
  if (operation === "add" && displayName === undefined) throw new Error("Usage: inoai allowlist:add --user-id <id> --display-name <name>");
  if (operation === "disable" && displayName !== undefined) throw new Error("--display-name is only valid with allowlist:add");
  return { operation, userId, ...(displayName === undefined ? {} : { displayName }), ...(connectDirectory === undefined ? {} : { connectDirectory }) };
}

export async function manageAllowlist(operation: AllowlistOperation, userId: string, displayName: string | undefined, launchDirectory = process.cwd(), connectDirectory?: string): Promise<UserRecord> {
  const { configuration } = await validate(launchDirectory, connectDirectory);
  const pool = createPostgresPool(configuration);
  const store = new PostgresOperationalStore(pool, configuration.agentInstanceId);
  try {
    await store.bootstrapOwner(configuration);
    return await manageAllowlistWithStore(store, operation, configuration.discordGuildId, userId, displayName);
  } finally {
    await store.close();
  }
}

// Tests may supply a scheduler clock so a wired run never depends on the time of day.
export type RunDependencies = { schedulerClock?: SchedulerClock; storeFactory?: (pool: unknown, runtimeHome: Awaited<ReturnType<typeof validate>>["runtimeHome"]) => OperationalStore };

export async function run(args: string[], suppliedTransport?: ChatTransport, suppliedRuntime?: AgentRuntime,
  supplied: RunDependencies = {}): Promise<void> {
  if (args[0] === "allowlist:add" || args[0] === "allowlist:disable") {
    const command = parseAllowlistCommand(args);
    const result = await manageAllowlist(command.operation, command.userId, command.displayName, process.cwd(), command.connectDirectory);
    console.log(JSON.stringify({ action: command.operation, user_id: result.external_user_id, guild_id: result.workspace_id, role: result.role, state: result.state }));
    return;
  }
  if (args[0] === "memory") {
    const { operation, argument, connectDirectory } = parseMemoryCommand(args.slice(1));
    const result = await manageMemory(operation, argument, process.cwd(), connectDirectory);
    console.log(JSON.stringify(result));
    return;
  }
  if (args[0] === "ui") {
    await launchUi(process.cwd(), parseConnectDirectory(args.slice(1)));
    return;
  }
  if (args[0] === "validate") {
    const { runtimeHome } = await validate(process.cwd(), parseConnectDirectory(args.slice(1)));
    console.log(`inoai configuration is valid: ${runtimeHome.directory}`);
    return;
  }
  const instance = await start(process.cwd(), parseConnectDirectory(args), supplied.storeFactory);
  const transport = suppliedTransport ?? createChatTransport(instance.configuration);
  let runtime = suppliedRuntime;
  let approvalRelay: ApprovalRelay | undefined;
  // A supplied test runtime, or a failed or unavailable probe, leaves the worker in its safe global mode.
  let probeConcurrency = async () => false;
  try {
    if (!runtime) {
      switch (instance.configuration.agentProvider) {
        case "codex": {
          const server = await CodexAppServer.connect();
          runtime = createCodexRuntime(server);
          approvalRelay = new ApprovalRelay(instance.store!, server, transport);
          probeConcurrency = probeCodexConcurrency;
          break;
        }
        case "claude":
          // The CLI denies prompts itself; the notifier only reports denials. A failed probe keeps global FIFO.
          runtime = await ClaudeRuntime.connect({ model: instance.configuration.claudeModel,
            onPermissionDenied: claudePermissionDenialNotifier(instance.store!, transport) });
          probeConcurrency = () => probeClaudeConcurrency();
          break;
        case "opencode":
          // OpenCode auto-rejects prompts in headless runs; the notifier only reports them. No concurrency probe yet,
          // so the home keeps global FIFO.
          runtime = await OpenCodeRuntime.connect({ onPermissionDenied: openCodePermissionDenialNotifier(instance.store!, transport) });
          break;
      }
    }
  } catch (error) {
    await instance.release();
    throw error;
  }
  const worker = new ConversationWorker(instance.store!, instance.runtimeHome, runtime, instance.configuration.agentProvider, () => {
    console.error("Conversation worker failed; stopping to preserve queue state");
    void shutdown(1).catch((failure: unknown) => {
      console.error(failure instanceof Error ? failure.message : failure);
      process.exitCode = 1;
    });
  }, transport);
  // Silent daily Memory Review cycle: it has no transport, and the worker tells it about every chat queue change so
  // chat always runs first.
  const scheduler = new MemoryReviewScheduler(instance.store!, runtime, {
    reviewTime: instance.configuration.memoryReviewTime, maxChars: instance.configuration.memoryReviewMaxChars,
    clock: supplied.schedulerClock,
    onFailure: () => console.error("Memory review scheduler failed; the review stays queued"),
  });
  worker.onQueueChange(() => scheduler.poke());
  const concurrentSessionsValidated = await probeConcurrency();
  let keepAlive: NodeJS.Timeout | undefined;
  let startup: Promise<ChatTransport> | undefined;
  let cleanup: Promise<void> | undefined;
  let signaled = false;
  const shutdown = (code: number): Promise<void> => cleanup ??= (async () => {
    try {
      try {
        instance.closing = true;
        await Promise.allSettled([...instance.pendingIngestion]);
        await transport.stop();
        // Abort an active review and let it settle before the worker closes the runtime.
        await scheduler.stop();
        await worker.stop();
      } finally {
        await startup?.catch(() => undefined);
      }
    } finally {
      approvalRelay?.close();
      try {
        await runtime.close();
      } finally {
        await instance.release();
        if (keepAlive) clearInterval(keepAlive);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.exitCode = code;
      }
    }
  })();
  const onSignal = () => {
    signaled = true;
    void shutdown(0).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    startup = startTransport(instance, undefined, transport, (error) => {
      console.error(error.message);
      void shutdown(1).catch((failure: unknown) => {
        console.error(failure instanceof Error ? failure.message : failure);
        process.exitCode = 1;
      });
    }, worker);
    await startup;
    if (concurrentSessionsValidated) worker.enablePerSessionConcurrency();
    scheduler.start();
    if (!suppliedRuntime) console.log(`${runtime.displayName} cross-session concurrency: ${concurrentSessionsValidated ? "enabled" : "unavailable; using global FIFO"}`);
  } catch (error) {
    await shutdown(1);
    if (signaled) return;
    throw error;
  }
  if (cleanup) {
    await cleanup;
    return;
  }
  keepAlive = setInterval(() => undefined, 2 ** 31 - 1);
  console.log(`inoai started with ${instance.runtimeHome.directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
