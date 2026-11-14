// FIXTURE PROTOTYPE (IP-0009 T-0005). T-0006 replaces this file with live read-model data.
// Fixture data for the read-only Connections block. The page shows it only with the
// `?connections-fixture` URL switch. It holds only the four fields the UI may show:
// name, type, allow list, and last status. It never holds command, args, url, headers, or env.

/** The newest `connection_status` event's status, or null when the connection has no event yet. */
export type FixtureConnectionStatus = "connected" | "failed" | "needs_auth" | "unknown" | null;

export type FixtureConnection = { name: string; type: "stdio" | "http"; allow: string[] | "all"; status: FixtureConnectionStatus };

/**
 * `file` is `absent` (no connections.json), `valid`, `invalid` (a Claude home with a bad file), or
 * `ignored` (a file on a non-Claude home).
 */
export type FixtureConnections = { file: "absent" | "valid" | "invalid" | "ignored"; list: FixtureConnection[] };

/** Named fixture scenarios. The first one is shown first. */
export const connectionFixtures: Record<string, FixtureConnections> = {
  mixed: { file: "valid", list: [
    { name: "github", type: "stdio", allow: ["search_issues", "get_issue"], status: "connected" },
    { name: "docs", type: "http", allow: "all", status: "connected" },
    { name: "jira", type: "http", allow: [], status: "failed" },
    { name: "kg-demo", type: "http", allow: ["search_grid", "get_page", "list_pages"], status: "needs_auth" },
    { name: "notes", type: "stdio", allow: ["read_note"], status: null },
  ] },
  connected: { file: "valid", list: [
    { name: "github", type: "stdio", allow: ["search_issues"], status: "connected" },
    { name: "docs", type: "http", allow: "all", status: "connected" },
  ] },
  failed: { file: "valid", list: [{ name: "kg-demo", type: "http", allow: ["search_grid", "get_page", "list_pages"], status: "failed" }] },
  "needs auth": { file: "valid", list: [{ name: "kg-demo", type: "http", allow: ["search_grid"], status: "needs_auth" }] },
  "not used yet": { file: "valid", list: [
    { name: "github", type: "stdio", allow: ["search_issues"], status: null },
    { name: "docs", type: "http", allow: "all", status: null },
  ] },
  "allow all": { file: "valid", list: [{ name: "docs", type: "http", allow: "all", status: "connected" }] },
  "allow none": { file: "valid", list: [{ name: "jira", type: "http", allow: [], status: "connected" }] },
  unknown: { file: "valid", list: [{ name: "github", type: "stdio", allow: ["search_issues"], status: "unknown" }] },
  "empty file": { file: "valid", list: [] },
  "no file": { file: "absent", list: [] },
  "invalid file": { file: "invalid", list: [] },
  "not claude": { file: "ignored", list: [] },
};
