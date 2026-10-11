import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapRuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { loadUiData } from "../api/read-model.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { launchUi } from "../server.js";
import { parseUiOptions, UI_DEFAULT_PORT } from "../common/options.js";

test("UI options default to port 8989 and accept a selected runtime", () => {
  assert.deepEqual(parseUiOptions(["--connect-dir", ".robin-xai-test"]), { connectDirectory: ".robin-xai-test", port: UI_DEFAULT_PORT });
  assert.deepEqual(parseUiOptions(["--connect-dir", ".inoai-connect-test", "--port", "9001"]), { connectDirectory: ".inoai-connect-test", port: 9001 });
  assert.throws(() => parseUiOptions(["--port", "0"]), /Usage/);
});

test("local UI binds to loopback and serves the dark tab shell", async () => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-test-"));
  await bootstrapRuntimeHome(deploymentDirectory, ".robin-xai-test");
  const ui = await launchUi(deploymentDirectory, ".robin-xai-test", 0);
  try {
    const address = ui.server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(address.address, "127.0.0.1");
    const html = await new Promise<string>((resolve, reject) => {
      const response = request({ host: "127.0.0.1", port: address.port, path: "/" }, (reply) => {
        let body = "";
        reply.setEncoding("utf8");
        reply.on("data", (chunk) => { body += chunk; });
        reply.on("end", () => resolve(body));
      });
      response.on("error", reject);
      response.end();
    });
    for (const tab of ["Overview", "Conversations", "Memory"]) assert.match(html, new RegExp(`>${tab}<`));
    assert.equal(html.includes(">Sessions<"), false);
    assert.equal(html.includes(">Events<"), false);
    assert.equal(html.includes(">Health<"), false);
    for (const field of ["ID", "Workspace", "Transport / direction", "State", "Created at", "Updated at"]) assert.match(html, new RegExp(`>${field}<`));
    assert.match(html, /Created at from/);
    assert.match(html, /Created at to/);
    assert.match(html, /agent\.md/);
    assert.match(html, /Skills &amp; tools/);
    for (const field of ["Origin", "Memory review", "Memory created at from", "Memory created at to"]) assert.match(html, new RegExp(field));
    assert.ok(html.indexOf('id="overview-panel"') < html.indexOf('id="conversations-panel"'));
    assert.ok(html.indexOf('id="conversations-panel"') < html.indexOf('<table class="activity message-table"'));
    assert.match(html, /data-theme="dark"/);
    assert.match(html, /Fixture-driven preview/);
    assert.equal(html.includes(".env"), false);
  } finally {
    await new Promise<void>((resolve) => ui.server.close(() => resolve()));
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
});

test("UI data reads the selected SQLite home and redacts secret-like content", async () => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-data-test-"));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".robin-xai-test");
  await writeFile(home.agentFile, "# Agent\nTOKEN=do-not-return\n", "utf8");
  const database = openDatabase(home);
  database.prepare("INSERT INTO users (transport, workspace_id, external_user_id) VALUES (?, ?, ?)").run("discord", "workspace-test", "owner");
  database.prepare("INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id, agent_provider, agent_session_id, project_path) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)").run("discord", "workspace-test", "parent", "conversation", "external", "codex", "session", deploymentDirectory);
  database.prepare("INSERT INTO messages (session_id, transport, workspace_id, external_message_id, direction, body) VALUES (1, ?, ?, ?, ?, ?)").run("discord", "workspace-test", "external", "user", "TOKEN=do-not-return");
  database.prepare("INSERT INTO memories (body, origin) VALUES (?, ?)").run("Use the local database", "manual");
  database.close();
  try {
    const data = await loadUiData(home);
    assert.equal(data.profile.provider, "codex");
    assert.equal(data.profile.status, "stopped");
    assert.deepEqual(data.profile.workspaceIds, ["workspace-test"]);
    assert.equal(data.messages[0]?.body, "TOKEN=[redacted]");
    assert.equal(data.memories[0]?.body, "Use the local database");
    assert.equal(data.agentMarkdown.includes("do-not-return"), false);
    assert.equal(JSON.stringify(data).includes("discord"), true);
    assert.equal(JSON.stringify(data).includes("do-not-return"), false);
  } finally {
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
});
