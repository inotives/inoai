import { lstat } from "node:fs/promises";
import { InvalidConnectionsError, loadConnections } from "./connections-file.js";

const shownLimit = 20;
const knownStatuses = new Set(["connected", "failed", "needs_auth", "unknown"]);

export type ConnectionStatusStore = { latestConnectionStatuses?(names: string[]): Promise<Record<string, string>> };

/**
 * The `/inoai status` connections line. It reads only connection names from `connections.json`, never `.env`, and
 * never fills in references. Each name shows the status from its newest `connection_status` event.
 */
export async function connectionsStatusLine(store: ConnectionStatusStore, connectionsFile: string, provider: string): Promise<string> {
  if (provider !== "claude") {
    const present = await lstat(connectionsFile).then(() => true, () => false);
    return present ? "Connections: ignored (Claude only)" : "Connections: none";
  }
  let names: string[];
  try {
    names = (await loadConnections(connectionsFile)).map((connection) => connection.name);
  } catch (error) {
    if (!(error instanceof InvalidConnectionsError)) throw error;
    return "Connections: invalid (run inoai connections validate)";
  }
  if (names.length === 0) return "Connections: none";
  const shown = names.slice(0, shownLimit);
  const statuses = store.latestConnectionStatuses ? await store.latestConnectionStatuses(shown) : undefined;
  const entries = shown.map((name) => {
    if (!statuses) return `${name} (status unknown)`;
    const status = statuses[name];
    if (status === undefined) return `${name} (not used yet)`;
    return `${name} (${knownStatuses.has(status) ? status : "unknown"})`;
  });
  if (names.length > shownLimit) entries.push(`and ${names.length - shownLimit} more`);
  return `Connections: ${entries.join(", ")}`;
}
