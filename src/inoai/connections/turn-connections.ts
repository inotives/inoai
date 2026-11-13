import type { ConnectionStatus, TurnConnections } from "../agent-runtime/ports.js";
import { InvalidConnectionsError, loadResolvedConnections } from "./connections-file.js";

export type ConnectionStatusReport = { name: string; status: ConnectionStatus }[];

/** One Turn's connections: the names in file order and the runtime options. Absent when the Turn has none. */
export type PreparedConnections = { names: string[]; turn: TurnConnections };

export const connectionsIgnoredWarning = "connections.json is ignored; connections are supported only on Claude homes in this version.";

/** Names the file and the problem. `reason` never holds a value from `.env` or the file. */
export function invalidConnectionsNotice(error: InvalidConnectionsError): string {
  return `The connections file connections.json is invalid: ${error.reason}. Fix it, then send a fresh request.`;
}

/**
 * Loads and resolves the home's connections for one Turn. Only Claude homes use connections; other providers and homes
 * without a file get undefined. Throws `InvalidConnectionsError` when the file cannot be used.
 */
export async function prepareTurnConnections(home: { connectionsFile: string; envFile: string }, provider: string): Promise<PreparedConnections | undefined> {
  if (provider !== "claude") return undefined;
  const resolved = await loadResolvedConnections(home);
  if (resolved.connections.length === 0) return undefined;
  return { names: resolved.connections.map((connection) => connection.name),
    turn: { mcpServers: resolved.mcpServers, allowedTools: resolved.allowedTools } };
}

/**
 * Records one `connection_status` event per connection. Without a runtime report (the Turn ended before `init`),
 * each connection is recorded as `unknown`. Best effort: a failed write never changes the Turn outcome.
 */
export async function recordConnectionStatuses(
  store: { createEvent(input: { session_id: number; message_id: number | null; event_type: string; detail: string }, actor: string): Promise<unknown> },
  sessionId: number, messageId: number | null, prepared: PreparedConnections, reported: ConnectionStatusReport | undefined, actor: string,
): Promise<void> {
  const statuses = reported ?? prepared.names.map((name) => ({ name, status: "unknown" as const }));
  for (const { name, status } of statuses) {
    try {
      await store.createEvent({ session_id: sessionId, message_id: messageId, event_type: "connection_status", detail: `name=${name} status=${status}` }, actor);
    } catch {
      // Status recording is best effort.
    }
  }
}

/** A short note for each connection that the runtime reported as not connected, or undefined when all connected. */
export function connectionFailureNote(reported: ConnectionStatusReport | undefined): string | undefined {
  const lines = (reported ?? []).flatMap(({ name, status }) => {
    switch (status) {
      case "connected": return [];
      case "failed": return [`Connection ${name} failed to start.`];
      case "needs_auth": return [`Connection ${name} needs authentication; check its credentials in .env.`];
      case "unknown": return [`Connection ${name} reported an unknown status.`];
    }
  });
  return lines.length ? lines.join("\n") : undefined;
}
