import { dirname } from "node:path";
import { manageLaunchAgent, parseLaunchAgentCommand } from "./heartbeat/launchagent.js";
import { runHeartbeat } from "./heartbeat/foreground.js";

import type { AgentRuntime } from "./agent-runtime/ports.js";
import { ApprovalRelay, legacyApprovalNotice, claudePermissionDenialNotifier, openCodePermissionDenialNotifier } from "./transport/approval-relay.js";
import { ClaudeRuntime } from "./connectors/agent-runtime/claude-runtime.js";
import { CodexAppServer } from "./connectors/agent-runtime/codex-app-server.js";
import { CodexRuntime } from "./connectors/agent-runtime/codex-runtime.js";
import { probeClaudeConcurrency, probeCodexConcurrency } from "./connectors/agent-runtime/concurrency-probe.js";
import { loadConfiguration } from "./agent-instance/config.js";
import type { UserRecord } from "./connectors/persistence/sqlite/legacy-database.js";
import type { MemoryRecord } from "./memory/ports.js";
import { ConversationWorker } from "./conversation/conversation-worker.js";
import { classifyIncomingMessage } from "./conversation/inbound-policy.js";
import { MemoryReviewScheduler } from "./memory/memory-review-scheduler.js";
import type { SchedulerClock } from "./memory/memory-review-scheduler.js";
import { OpenCodeRuntime } from "./connectors/agent-runtime/opencode-runtime.js";
import { acquireRuntimeHomeLock, bootstrapRuntimeHome, inspectRuntimeHomeLock, resolveRuntimeHome } from "./agent-instance/runtime-home.js";
import { createChatTransport } from "./connectors/discord/discord.js";
import type { ChatTransport, IncomingMessage, ThreadControl } from "./transport/ports.js";
export type { ChatTransport, IncomingMessage, ThreadControl } from "./transport/ports.js";
import type { OperationalStore } from "./persistence/operational-store.js";
import { openDatabase, withMaintenanceDatabase } from "./connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "./connectors/persistence/sqlite/operational-store.js";
import { manageMemoryWithStore } from "./memory/memory-operations.js";
import { loadAgentProfile } from "./agent-instance/profile.js";
import { disableSkill, enableSkill, installSkillPackage, listInstalledSkills, removeSkill, updateSkillPackage } from "./skills/skill-lifecycle.js";
import { acquireSkillPackage, updateAcquiredSkillPackage } from "./skills/skill-acquisition.js";
import { parseHeartbeatSetupCommand, runHeartbeatSetup } from "./heartbeat/setup.js";

export const appName = "inoai";
export * from "./agent-instance/config.js";
export * from "./agent-runtime/ports.js";
export * from "./conversation/agent-session.js";
export * from "./transport/approval-relay.js";
export * from "./connectors/agent-runtime/claude-runtime.js";
export * from "./connectors/agent-runtime/codex-app-server.js";
export * from "./connectors/agent-runtime/codex-runtime.js";
export * from "./conversation/conversation-worker.js";
export * from "./connectors/persistence/sqlite/legacy-database.js";
export * from "./transport/inbound-policy.js";
export * from "./memory/memory-review.js";
export * from "./memory/memory-review-scheduler.js";
export * from "./memory/memory-operations.js";
export * from "./connectors/persistence/postgres/lease.js";
export * from "./agent-instance/runtime-home.js";
export * from "./agent-instance/profile.js";
export * from "./skills/skill-manifest.js";
export * from "./skills/skill-lifecycle.js";
export * from "./skills/skill-loader.js";
export * from "./skills/skill-execution.js";
export * from "./conversation/runtime-turn.js";
export * from "./connectors/discord/discord.js";

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

export async function validateProfile(launchDirectory = process.cwd(), connectDirectory?: string) {
  const runtimeHome = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
  const profile = await loadAgentProfile(runtimeHome.agentFile);
  return { runtimeHome, profile };
}

export async function start(launchDirectory = process.cwd(), connectDirectory?: string, storeFactory?: (runtimeHome: Awaited<ReturnType<typeof validate>>["runtimeHome"]) => OperationalStore) {
  const { runtimeHome, configuration } = await validate(launchDirectory, connectDirectory);
  const release = await acquireRuntimeHomeLock(runtimeHome);
  let store: OperationalStore | undefined;
  try {
    store = storeFactory?.(runtimeHome) ?? createSqliteOperationalStore(openDatabase(runtimeHome));
    const owner = await store.bootstrapOwner(configuration);
    const pendingIngestion = new Set<Promise<void>>();
    const activeStore = store;
    let cleanup: Promise<void> | undefined;
    const instance = {
      runtimeHome,
      configuration,
      store: activeStore,
      owner,
      pendingIngestion,
      closing: false,
      release: () => cleanup ??= (async () => {
        instance.closing = true;
        await Promise.allSettled([...pendingIngestion]);
        try {
          await activeStore.close();
        } finally {
          await release();
        }
      })(),
    };
    return instance;
  } catch (error) {
    try {
      await store?.close();
    } finally {
      await release();
    }
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
      for (const approval of await store.legacyApprovalNotices?.() ?? []) {
        if (approval.workspace_id !== instance.configuration.discordGuildId) continue;
        if (!await store.claimLegacyApprovalNotice?.(approval.id)) continue;
        if (approval.external_message_id) {
          await transport.disableLegacyApprovalControls?.(approval.conversation_id, approval.external_message_id);
        }
        const externalMessageId = await transport.sendMessage(approval.conversation_id, legacyApprovalNotice);
        const archived = await store.archiveMessage({
          session_id: approval.session_id, transport: approval.transport, workspace_id: approval.workspace_id,
          external_message_id: externalMessageId, external_author_id: null, user_id: null,
          direction: "agent", body: legacyApprovalNotice, reply_to_external_message_id: null,
          in_reply_to_message_id: null, state: "completed",
        }, "transport:discord");
        if (archived.message) await store.resolveLegacyApprovalNotice?.(approval.id, archived.message.id);
      }
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
  const instance = await start(launchDirectory, connectDirectory);
  const { store, owner } = instance;
  try {
    return await manageMemoryWithStore(store, operation, argument, owner.id);
  } finally {
    await instance.release();
  }
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

export type SkillOperation = "add" | "install" | "update" | "enable" | "disable" | "list" | "remove";
export type SkillCommand = { operation: SkillOperation; connectDirectory?: string; agent?: string; source?: string; packageDirectory?: string; skillId?: string; approvedBy?: string; yes?: boolean };

export function resolveSkillConnectDirectory(agent?: string, connectDirectory?: string): string | undefined {
  if (agent !== undefined && connectDirectory !== undefined) throw new Error("Use only one of --agent or --connect-dir");
  if (agent !== undefined) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) throw new Error("--agent must be a safe Agent Instance name");
    return `.inoai-connect-${agent}`;
  }
  return connectDirectory;
}

export function parseSkillsCommand(args: string[]): SkillCommand {
  const operation = args[0] as SkillOperation | undefined;
  const usage = "Usage: inoai skills <add <source> --skill <id>|list|enable <id>|disable <id>|update <id>|remove <id> --yes> [--agent <name>|--connect-dir .inoai-connect*]";
  if (!operation || !["add", "install", "update", "enable", "disable", "list", "remove"].includes(operation)) throw new Error(usage);
  const result: SkillCommand = { operation };
  const values = args.slice(1);
  const positional: string[] = [];
  const flags = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag.startsWith("--")) { positional.push(flag); continue; }
    flags.add(flag);
    if (flag === "--yes") { result.yes = true; continue; }
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--connect-dir") result.connectDirectory = value;
    else if (flag === "--agent") result.agent = value;
    else if (flag === "--source") result.source = value;
    else if (flag === "--package-dir") result.packageDirectory = value;
    else if (flag === "--skill" || flag === "--skill-id") result.skillId = value;
    else if (flag === "--approved-by") result.approvedBy = value;
    else throw new Error(usage);
  }
  const allowedFlags: Record<SkillOperation, string[]> = {
    add: ["--connect-dir", "--agent", "--source", "--skill", "--skill-id"],
    install: ["--connect-dir", "--agent", "--package-dir"],
    update: ["--connect-dir", "--agent", "--package-dir", "--skill", "--skill-id"],
    enable: ["--connect-dir", "--agent", "--skill", "--skill-id", "--approved-by"],
    disable: ["--connect-dir", "--agent", "--skill", "--skill-id"],
    list: ["--connect-dir", "--agent"],
    remove: ["--connect-dir", "--agent", "--skill", "--skill-id", "--yes"],
  };
  if ([...flags].some((flag) => !allowedFlags[operation].includes(flag))) throw new Error(usage);
  if (operation === "add") result.source ??= positional.shift();
  if (["enable", "disable", "update", "remove"].includes(operation)) result.skillId ??= positional.shift();
  if (operation === "install" || (operation === "update" && result.packageDirectory)) result.packageDirectory ??= positional.shift();
  result.connectDirectory = resolveSkillConnectDirectory(result.agent, result.connectDirectory);
  if (positional.length) throw new Error(usage);
  if (operation === "add" && (!result.source || !result.skillId)) throw new Error(usage);
  if (operation === "install" && !result.packageDirectory) throw new Error(usage);
  if (operation === "update" && !result.skillId && !result.packageDirectory) throw new Error(usage);
  if (["enable", "disable", "update", "remove"].includes(operation) && !result.skillId && !result.packageDirectory) throw new Error(usage);
  if (operation === "enable") result.approvedBy ??= "owner";
  if (operation === "remove" && !result.yes) throw new Error("Skill removal requires --yes confirmation");
  if (operation === "list" && (result.source || result.packageDirectory || result.skillId || result.approvedBy || result.yes)) throw new Error(usage);
  return result;
}

export async function manageAllowlist(operation: AllowlistOperation, userId: string, displayName: string | undefined, launchDirectory = process.cwd(), connectDirectory?: string): Promise<UserRecord> {
  try {
    const runtimeHome = resolveRuntimeHome(launchDirectory, connectDirectory);
    if (await inspectRuntimeHomeLock(runtimeHome.lockFile) === "live") {
      const configuration = await loadConfiguration(runtimeHome.envFile);
      if (userId === configuration.discordOwnerUserId) throw new Error("The configured Discord owner cannot be changed by this command");
      return await withMaintenanceDatabase(runtimeHome, (database) =>
        manageAllowlistWithStore(createSqliteOperationalStore(database), operation, configuration.discordGuildId, userId, displayName));
    }

    const instance = await start(launchDirectory, connectDirectory);
    try {
      return await manageAllowlistWithStore(instance.store, operation, instance.configuration.discordGuildId, userId, displayName);
    } finally {
      await instance.release();
    }
  } catch (error) {
    if (isSqliteBusyError(error)) throw new Error("SQLite database is busy. Retry the allowlist command shortly.");
    throw error;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: string; errcode?: number; errno?: number };
  return sqliteError.code === "SQLITE_BUSY" || sqliteError.code === "SQLITE_LOCKED"
    || [5, 6].includes(sqliteError.errcode ?? sqliteError.errno ?? -1)
    || /database is (?:locked|busy)/i.test(error.message);
}

// Tests may supply a scheduler clock so a wired run never depends on the time of day.
export type RunDependencies = { heartbeat?: typeof runHeartbeat; heartbeatSetup?: typeof runHeartbeatSetup; launchagent?: typeof manageLaunchAgent; schedulerClock?: SchedulerClock; storeFactory?: (runtimeHome: Awaited<ReturnType<typeof validate>>["runtimeHome"]) => OperationalStore };

export async function run(args: string[], suppliedTransport?: ChatTransport, suppliedRuntime?: AgentRuntime,
  supplied: RunDependencies = {}): Promise<void> {
  if (args[0] === "heartbeat" && args[1] === "launchagent") {
    console.log(await (supplied.launchagent ?? manageLaunchAgent)(process.cwd(), parseLaunchAgentCommand(args.slice(2))));
    return;
  }
  if (args[0] === "heartbeat" && args[1] === "setup") {
    console.log(await (supplied.heartbeatSetup ?? runHeartbeatSetup)(process.cwd(), parseHeartbeatSetupCommand(args.slice(2))));
    return;
  }
  if (args[0] === "heartbeat") {
    await (supplied.heartbeat ?? runHeartbeat)(process.cwd(), parseConnectDirectory(args.slice(1)));
    return;
  }
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
  if (args[0] === "validate") {
    const { runtimeHome } = await validate(process.cwd(), parseConnectDirectory(args.slice(1)));
    console.log(`inoai configuration is valid: ${runtimeHome.directory}`);
    return;
  }
  if (args[0] === "profile" && args[1] === "validate") {
    const { runtimeHome } = await validateProfile(process.cwd(), parseConnectDirectory(args.slice(2)));
    console.log(`inoai agent profile is valid: ${runtimeHome.agentFile}`);
    return;
  }
  if (args[0] === "skills") {
    const command = parseSkillsCommand(args.slice(1));
    const runtimeHome = await bootstrapRuntimeHome(process.cwd(), command.connectDirectory);
    if (command.operation === "add") {
      const installed = await acquireSkillPackage(runtimeHome, { source: command.source!, skill: command.skillId! });
      console.log(JSON.stringify({ action: "add", id: installed.manifest.id, version: installed.manifest.version, hash: installed.hash, enabled: false }));
      return;
    }
    if (command.operation === "install") {
      const installed = await installSkillPackage(runtimeHome, command.packageDirectory!);
      console.log(JSON.stringify({ action: "install", id: installed.manifest.id, version: installed.manifest.version, hash: installed.hash, enabled: false }));
      return;
    }
    if (command.operation === "update") {
      const installed = command.packageDirectory
        ? await updateSkillPackage(runtimeHome, command.packageDirectory)
        : await updateAcquiredSkillPackage(runtimeHome, command.skillId!);
      console.log(JSON.stringify({ action: "update", id: installed.manifest.id, version: installed.manifest.version, hash: installed.hash, enabled: false, approval_required: true }));
      return;
    }
    if (command.operation === "enable") {
      const record = await enableSkill(runtimeHome, command.skillId!, command.approvedBy!);
      console.log(JSON.stringify({ action: "enable", id: record.id, version: record.version, hash: record.hash, approved_by: record.approved_by }));
      return;
    }
    if (command.operation === "disable") {
      console.log(JSON.stringify({ action: "disable", id: command.skillId, disabled: await disableSkill(runtimeHome, command.skillId!) }));
      return;
    }
    if (command.operation === "remove") {
      console.log(JSON.stringify({ action: "remove", id: command.skillId, removed: await removeSkill(runtimeHome, command.skillId!) }));
      return;
    }
    console.log(JSON.stringify((await listInstalledSkills(runtimeHome)).map((skill) => ({
      id: skill.manifest.id, version: skill.manifest.version, hash: skill.hash, enabled: skill.enabled,
    }))));
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
