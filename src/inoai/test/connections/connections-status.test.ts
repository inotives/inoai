import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start, startTransport } from "../../app.js";
import { createEvent, createSession, openDatabase, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { connectionsStatusLine } from "../../connections/connections-status.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../../transport/ports.js";

const secret = "s3cr3t-value-never-shown";
const twoConnections = JSON.stringify({ version: 1, connections: {
  github: { type: "stdio", command: "npx", args: ["server-github"], env: { TOKEN: "${GITHUB_TOKEN}" }, allow: ["search_issues"] },
  docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_KEY}" }, allow: "all" },
} });

async function withFile(text: string | undefined, fn: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-connections-status-"));
  try {
    const file = join(directory, "connections.json");
    if (text !== undefined) await writeFile(file, text);
    await fn(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const noEvents = { async latestConnectionStatuses() { return {}; } };

test("a Claude home with no file, or a file with no connections, shows none", async () => {
  await withFile(undefined, async (file) => assert.equal(await connectionsStatusLine(noEvents, file, "claude"), "Connections: none"));
  await withFile(JSON.stringify({ version: 1, connections: {} }), async (file) =>
    assert.equal(await connectionsStatusLine(noEvents, file, "claude"), "Connections: none"));
});

test("a Claude home shows each connection's newest status, or not used yet", async () => {
  await withFile(twoConnections, async (file) => {
    let asked: string[] = [];
    const store = { async latestConnectionStatuses(names: string[]) { asked = names; return { github: "needs_auth" }; } };
    assert.equal(await connectionsStatusLine(store, file, "claude"), "Connections: github (needs_auth), docs (not used yet)");
    assert.deepEqual(asked, ["github", "docs"]);
    const odd = { async latestConnectionStatuses() { return { github: "connected", docs: "weird" }; } };
    assert.equal(await connectionsStatusLine(odd, file, "claude"), "Connections: github (connected), docs (unknown)");
  });
});

test("the line shows the first 20 names, asks only for their statuses, and counts the rest", async () => {
  const names = Array.from({ length: 23 }, (_, index) => `c${index}`);
  const text = JSON.stringify({ version: 1, connections: Object.fromEntries(names.map((name) => [name, { type: "stdio", command: "npx", allow: [] }])) });
  await withFile(text, async (file) => {
    let asked: string[] = [];
    const store = { async latestConnectionStatuses(requested: string[]) { asked = requested; return { c0: "connected" }; } };
    const line = await connectionsStatusLine(store, file, "claude");
    assert.deepEqual(asked, names.slice(0, 20));
    assert.equal(line, `Connections: c0 (connected), ${names.slice(1, 20).map((name) => `${name} (not used yet)`).join(", ")}, and 3 more`);
  });
});

test("a store without the status read shows status unknown", async () => {
  await withFile(twoConnections, async (file) =>
    assert.equal(await connectionsStatusLine({}, file, "claude"), "Connections: github (status unknown), docs (status unknown)"));
});

test("an invalid file on a Claude home shows a value-free invalid line", async () => {
  for (const text of ["{ not json", JSON.stringify({ version: 1, connections: { bad: { type: "stdio", command: secret, allow: "some" } } })]) {
    await withFile(text, async (file) => {
      const line = await connectionsStatusLine(noEvents, file, "claude");
      assert.equal(line, "Connections: invalid (run inoai connections validate)");
    });
  }
});

test("other providers show ignored when the file exists, even when invalid, and none otherwise", async () => {
  for (const provider of ["codex", "opencode", "anthropic-api"]) {
    await withFile(twoConnections, async (file) => assert.equal(await connectionsStatusLine(noEvents, file, provider), "Connections: ignored (Claude only)"));
    await withFile("{ not json", async (file) => assert.equal(await connectionsStatusLine(noEvents, file, provider), "Connections: ignored (Claude only)"));
    await withFile(undefined, async (file) => assert.equal(await connectionsStatusLine(noEvents, file, provider), "Connections: none"));
  }
});

test("the line never shows command, args, url, headers, or env values", async () => {
  await withFile(twoConnections, async (file) => {
    const line = await connectionsStatusLine({ async latestConnectionStatuses() { return { github: "failed", docs: "connected" }; } }, file, "claude");
    assert.equal(line, "Connections: github (failed), docs (connected)");
    assert.doesNotMatch(line, /npx|server-github|mcp\.example|Bearer|GITHUB_TOKEN|DOCS_KEY/);
  });
});

test("the SQLite store reads the newest connection_status event per name across Sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-connections-status-db-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    const database = openDatabase(home);
    try {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = (thread: string) => createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: thread, initiating_external_message_id: `start-${thread}`,
        agent_provider: "claude", agent_session_id: `claude-${thread}`, project_path: directory });
      const first = session("t1");
      const second = session("t2");
      const event = (sessionId: number, detail: string) => createEvent(database, { session_id: sessionId, message_id: null, event_type: "connection_status", detail });
      event(first.id, "name=github status=connected");
      event(second.id, "name=github status=failed");
      event(first.id, "name=git_hub status=connected");
      event(first.id, "name=docs status=needs_auth");
      createEvent(database, { session_id: first.id, message_id: null, event_type: "other", detail: "name=docs status=connected" });
      const store = createSqliteOperationalStore(database);
      assert.deepEqual(await store.latestConnectionStatuses!(["github", "docs", "gitxhub", "missing"]),
        { github: "failed", docs: "needs_auth" });
      assert.deepEqual(await store.latestConnectionStatuses!(["git_hub"]), { git_hub: "connected" });
    } finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class ControlTransport implements ChatTransport {
  private onControl?: (control: ThreadControl) => Promise<void>;
  async start(_onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void,
    onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.onControl = onControl;
    await onReady?.();
  }
  async status(): Promise<string> {
    let answer = "";
    await this.onControl?.({ command: "status", workspaceId: "guild", conversationId: "thread-1", parentConversationId: "channel",
      guildTextChannelId: "channel", externalUserId: "owner", conversationOwnedByBot: false, respond: async (text) => { answer = text; } });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> { return "thread"; }
  async deleteConversation(): Promise<void> {}
  async sendMessage(): Promise<string> { return "sent"; }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: "ready", botUserId: "inoai" }; }
}

test("/inoai status ends with the Connections line on a Claude home", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-connections-status-app-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
      "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=claude", "MEMORY_REVIEW_TIME=06:00",
      "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test", `GITHUB_TOKEN=${secret}`, `DOCS_KEY=${secret}`].join("\n"));
    const instance = await start(directory);
    try {
      const session = await instance.store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread-1", initiating_external_message_id: "start-1",
        agent_provider: "claude", agent_session_id: "claude-1", project_path: directory });
      const transport = new ControlTransport();
      await startTransport(instance, undefined, transport);
      assert.match(await transport.status(), /\nRole: none\nConnections: none$/);
      await writeFile(home.connectionsFile, twoConnections);
      await instance.store.createEvent({ session_id: session.id, message_id: null, event_type: "connection_status", detail: "name=docs status=failed" }, "test");
      const status = await transport.status();
      assert.match(status, /\nConnections: github \(not used yet\), docs \(failed\)$/);
      assert.doesNotMatch(status, new RegExp(`${secret}|npx|mcp\\.example`));
      await writeFile(home.connectionsFile, "{ not json");
      assert.match(await transport.status(), /\nConnections: invalid \(run inoai connections validate\)$/);
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
