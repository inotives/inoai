import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfiguration } from "./config.js";
import { archiveMessage, bootstrapOwner, claimLegacyApprovalNotice, createEvent, createMemory, createSession, legacyApprovalNotices, listMemories, openDatabase, resolveLegacyApprovalNotice, softDeleteMemory } from "./database.js";
import type { MemoryRecord } from "./database.js";
import { classifyIncomingMessage } from "./inbound-policy.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "./runtime-home.js";
import { createChatTransport } from "./transport.js";
import type { ChatTransport, IncomingMessage } from "./transport.js";
import { launchUi } from "./ui.js";

export const appName = "inoai";
export * from "./config.js";
export * from "./agent-runtime.js";
export * from "./agent-session.js";
export * from "./approval-relay.js";
export * from "./codex-app-server.js";
export * from "./codex-runtime.js";
export * from "./database.js";
export * from "./inbound-policy.js";
export * from "./runtime-home.js";
export * from "./runtime-turn.js";
export * from "./transport.js";
export * from "./ui.js";

export async function validate(launchDirectory = process.cwd(), connectDirectory?: string) {
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const configuration = await loadConfiguration(runtimeHome.envFile);
  return { runtimeHome, configuration };
}

export async function start(launchDirectory = process.cwd(), connectDirectory?: string) {
  const { runtimeHome, configuration } = await validate(launchDirectory, connectDirectory);
  const release = await acquireRuntimeHomeLock(runtimeHome);
  try {
    const database = openDatabase(runtimeHome);
    const owner = bootstrapOwner(database, configuration);
    const pendingIngestion = new Set<Promise<void>>();
    const instance = {
      runtimeHome,
      configuration,
      database,
      owner,
      pendingIngestion,
      closing: false,
      release: async () => {
        instance.closing = true;
        await Promise.allSettled([...pendingIngestion]);
        database.close();
        await release();
      },
    };
    return instance;
  } catch (error) {
    await release();
    throw error;
  }
}

export async function startTransport(
  instance: Awaited<ReturnType<typeof start>>,
  onIncomingMessage?: (message: IncomingMessage) => void,
  transport: ChatTransport = createChatTransport(instance.configuration),
  onFailure?: (error: Error) => void,
): Promise<ChatTransport> {
  const inFlight = new Set<string>();
  const receive = onIncomingMessage ?? ((message: IncomingMessage) => {
    if (instance.closing) return;
    const eligible = classifyIncomingMessage(instance.database, instance.configuration, message);
    const workspaceId = message.workspaceId;
    if (eligible?.kind === "bound-thread" && workspaceId !== null) {
      try {
        archiveMessage(instance.database, {
          session_id: eligible.session.id, transport: message.transport, workspace_id: workspaceId,
          external_message_id: message.externalMessageId, external_author_id: message.externalUserId,
          user_id: eligible.user.id, direction: "user", body: message.body,
          reply_to_external_message_id: message.replyToExternalMessageId, in_reply_to_message_id: null,
        }, "transport:discord");
      } catch (error) {
        console.error("Discord thread message failed:", error instanceof Error ? error.message : error);
      }
      return;
    }
    if (eligible?.kind !== "top-level" || workspaceId === null || inFlight.has(message.externalMessageId)) return;
    const existing = instance.database.prepare(`SELECT id FROM sessions
      WHERE transport = ? AND workspace_id = ? AND initiating_external_message_id = ?`).get(
      message.transport, workspaceId, message.externalMessageId,
    );
    if (existing) return;

    inFlight.add(message.externalMessageId);
    const pending = (async () => {
      let conversationId: string | undefined;
      try {
        conversationId = await transport.createConversation(
          message.conversationId, message.externalMessageId, message.body.trim().slice(0, 100) || "inoai conversation",
        );
        instance.database.exec("BEGIN IMMEDIATE");
        try {
          const session = createSession(instance.database, {
            user_id: eligible.user.id, transport: message.transport, workspace_id: workspaceId,
            parent_conversation_id: message.conversationId, conversation_id: conversationId,
            initiating_external_message_id: message.externalMessageId, agent_provider: instance.configuration.agentProvider,
            agent_session_id: `pending:${message.externalMessageId}`, project_path: dirname(instance.runtimeHome.directory),
          }, "transport:discord");
          const archived = archiveMessage(instance.database, {
            session_id: session.id, transport: message.transport, workspace_id: workspaceId,
            external_message_id: message.externalMessageId, external_author_id: message.externalUserId,
            user_id: eligible.user.id, direction: "user", body: message.body,
            reply_to_external_message_id: message.replyToExternalMessageId, in_reply_to_message_id: null,
          }, "transport:discord");
          if (!archived.inserted) throw new Error("Initiating Discord message already archived");
          instance.database.exec("COMMIT");
        } catch (error) {
          instance.database.exec("ROLLBACK");
          throw error;
        }
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
  });
  try {
    await transport.start(receive, async () => {
      if (transport.health().state !== "ready") throw new Error("Discord disconnected before startup announcement");
      for (const approval of legacyApprovalNotices(instance.database)) {
        if (approval.external_message_id) {
          // No interaction handler can approve an old button; scrub it when Discord still exposes the message.
          await transport.disableLegacyApprovalControls?.(approval.conversation_id, approval.external_message_id).catch(() => undefined);
        }
        // Claim before the network send: a crash may omit this notice, but cannot duplicate it.
        if (!claimLegacyApprovalNotice(instance.database, approval.id)) continue;
        const notice = "A saved Codex approval could not be resumed after restart. No action was approved. Please make a fresh request.";
        const externalMessageId = await transport.sendMessage(approval.conversation_id, notice);
        instance.database.exec("BEGIN IMMEDIATE");
        try {
          const archived = archiveMessage(instance.database, {
            session_id: approval.session_id, transport: approval.transport, workspace_id: approval.workspace_id,
            external_message_id: externalMessageId, external_author_id: null, user_id: null,
            direction: "agent", body: notice, reply_to_external_message_id: null, in_reply_to_message_id: null,
            state: "completed",
          }, "startup-recovery");
          if (!archived.message) throw new Error("Legacy approval notice was not archived");
          resolveLegacyApprovalNotice(instance.database, approval.id, archived.message.id);
          instance.database.exec("COMMIT");
        } catch (error) {
          instance.database.exec("ROLLBACK");
          throw error;
        }
      }
      const messageId = await transport.publishHealth(instance.configuration.discordAllowedChannelId, "inoai is online", instance.configuration.discordGuildId);
      if (transport.health().state !== "ready") throw new Error("Discord disconnected during startup announcement");
      createEvent(instance.database, {
        session_id: null,
        message_id: null,
        event_type: "startup_online",
        detail: `discord message ${messageId}`,
      }, "transport:discord");
    }, onFailure);
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
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const database = openDatabase(runtimeHome);
  try {
    const owner = database.prepare("SELECT id FROM users WHERE role = 'owner' AND state = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    const actor = owner ? `manual-cli:user:${owner.id}` : "manual-cli";
    if (operation === "list") return listMemories(database);
    if (operation === "add") {
      const body = argument?.trim();
      if (!body) throw new Error("Usage: inoai memory add <text>");
      return createMemory(database, {
        body,
        source_message_id: null,
        created_by_user_id: owner?.id ?? null,
        review_id: null,
        origin: "manual",
      }, actor);
    }
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Usage: inoai memory delete <id>");
    if (!listMemories(database).some((memory) => memory.id === id)) throw new Error(`Manual Memory Entry not found: ${id}`);
    softDeleteMemory(database, id, actor);
  } finally {
    database.close();
  }
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

export async function run(args: string[], suppliedTransport?: ChatTransport): Promise<void> {
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
  const instance = await start(process.cwd(), parseConnectDirectory(args));
  const transport = suppliedTransport ?? createChatTransport(instance.configuration);
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
      } finally {
        await startup?.catch(() => undefined);
      }
    } finally {
      await instance.release();
      if (keepAlive) clearInterval(keepAlive);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.exitCode = code;
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
    });
    await startup;
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
