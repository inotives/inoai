import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("local UI binds to loopback and serves the dark ring console", async () => {
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
    assert.match(html, /data-theme="dark"/);
    assert.match(html, /three@0\.160\.0/);
    assert.match(html, /cdn-uicons\.flaticon\.com\/2\.6\.0\/uicons-regular-rounded/);
    assert.match(html, /fetch\('\/api\/ui-data'/);
    for (const section of ["profile", "health", "activity", "failures", "tasks", "conversations", "memory", "skills"]) assert.match(html, new RegExp(`${section}: \\(v\\) =>`));
    assert.match(html, /settings: \(\) =>/);
    assert.match(html, /inoai\.robotColor\./);
    assert.match(html, /aria-label="Close details"/);
    assert.equal(html.includes("Fixture-driven preview"), false);
    assert.match(html, /Anomaly event log/);
    const styles = [...html.matchAll(/\{ id: '([a-z]+)', name: '[a-z ]+', rows: \[([^\]]+)\] \}/g)];
    assert.equal(styles.length, 20, "twenty robot styles");
    const accessories = [...html.matchAll(/\{ id: '([a-z]+)', name: '[a-z ]+', anchor: '(top|float|face|chest)', rows: \[([^\]]*)\] \}/g)];
    assert.equal(accessories.length, 10, "ten accessories including none");
    for (const [, id, , rows] of accessories.filter(([, id]) => id !== "none")) {
      const map = rows.split(", ").map((row) => row.slice(1, -1));
      assert.ok(map.every((row) => row.length === map[0]!.length && /^[.YKWRBPVN]+$/.test(row)), `accessory ${id} rows`);
    }
    for (const finish of ["matte", "shiny", "glow", "wire"]) assert.match(html, new RegExp(`'${finish}'`));
    for (const [, id, rows] of styles) {
      const map = rows.split(", ").map((row) => row.slice(1, -1));
      assert.ok(map.every((row) => row.length === map[0]!.length && /^[.HDEMGsaAL]+$/.test(row)), `robot style ${id} rows`);
    }
    assert.match(html, /No anomalies in the last 24 hours/);
    // Activity: a 24h / 7d / 30d window switch and seven charts replace the message list.
    assert.match(html, /const INSIGHT_WINDOWS = \['24h', '7d', '30d'\];/);
    assert.match(html, /'aria-label': 'Chart window'/);
    for (const [key, title] of [["tokens", "Token usage"], ["conversation-types", "Conversation types"], ["task-runs", "Task runs"], ["volume", "Message volume"], ["reply-time", "Reply time"], ["failures", "Failures by cause"], ["skills", "Skill calls"]]) {
      assert.ok(html.includes(`chartCard('${key}', '${title}'`), `chart ${key} is rendered`);
    }
    assert.match(html, /createElementNS\(SVG_NS/);
    assert.match(html, /'no data yet'/);
    assert.equal(html.includes("recent.map(messageItem)"), false);
    const pageScript = html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";
    assert.doesNotThrow(() => new Function(`return async () => {${pageScript}}`), "page script must parse");
    assert.equal(html.includes(".env"), false);
  } finally {
    await new Promise<void>((resolve) => ui.server.close(() => resolve()));
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
});

test("UI data lists enabled skill files with redacted text and no binary content", async () => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-skill-test-"));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".robin-xai-test");
  const skillDirectory = join(home.skillsDirectory, "demo-skill");
  await mkdir(join(skillDirectory, "assets"), { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\ndescription: Demo\n---\n# Demo\nTOKEN=do-not-return\n", "utf8");
  await writeFile(join(skillDirectory, "skill.yaml"), "id: demo-skill\n", "utf8");
  await writeFile(join(skillDirectory, "assets", "logo.bin"), Buffer.from([0, 1, 2]));
  await writeFile(home.skillsEnabledFile, JSON.stringify({ version: 1, skills: [{ id: "demo-skill", version: "1.0.0", hash: "a".repeat(64), approved_by: "owner", approved_at: "2026-10-01T00:00:00Z", capabilities: { filesystem: "read-only", network: false, "process/command": false, external_mutation: false } }] }), "utf8");
  openDatabase(home).close();
  try {
    const data = await loadUiData(home);
    assert.deepEqual(data.skills, ["demo-skill"]);
    const skill = data.skillDetails[0];
    assert.equal(skill?.capabilities.filesystem, "read-only");
    assert.deepEqual(skill?.files.map((file) => file.path), ["SKILL.md", "assets/logo.bin", "skill.yaml"]);
    assert.match(skill?.files[0]?.text ?? "", /TOKEN=\[redacted\]/);
    assert.equal(skill?.files[1]?.text, null);
    assert.equal(JSON.stringify(data).includes("do-not-return"), false);
  } finally {
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
});

test("UI data lists tasks with run counts and redacted goals", async () => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-tasks-test-"));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".robin-xai-test");
  const database = openDatabase(home);
  database.prepare("INSERT INTO users (transport, workspace_id, external_user_id) VALUES ('discord', 'w', 'owner')").run();
  for (const id of [1, 2, 3]) database.prepare("INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id, agent_provider, agent_session_id, project_path) VALUES (1, 'discord', 'w', 'p', ?, ?, 'codex', ?, ?)").run(`c${id}`, `e${id}`, `s${id}`, deploymentDirectory);
  const task = database.prepare("INSERT INTO tasks (goal, task_type, interval_seconds, state, conversation_id, session_id, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  task.run("Summarize CI TOKEN=do-not-return", "recurring", 43200, "active", "c1", 1, 2_000_000_000);
  task.run("One-off report", "one_time", null, "completed", "c2", 2, null);
  task.run("Deleted task", "one_time", null, "cancelled", "c3", 3, null);
  database.prepare("UPDATE tasks SET deleted_at = unixepoch(), deleted_by = 'owner' WHERE goal = 'Deleted task'").run();
  const run = database.prepare("INSERT INTO task_runs (task_id, state, started_at, completed_at) VALUES (?, ?, ?, ?)");
  run.run(1, "completed", 100, 110);
  run.run(1, "failed", 200, 210);
  run.run(1, "completed", 300, 310);
  database.prepare("UPDATE task_runs SET deleted_at = unixepoch(), deleted_by = 'owner' WHERE started_at = 300").run();
  database.close();
  try {
    const data = await loadUiData(home);
    assert.deepEqual(data.tasks.map((x) => x.goal).sort(), ["One-off report", "Summarize CI TOKEN=[redacted]"]);
    const recurring = data.tasks.find((x) => x.taskType === "recurring");
    assert.equal(recurring?.intervalSeconds, 43200);
    assert.deepEqual(recurring?.runs, { completed: 1, failed: 1, lastState: "failed", lastAt: new Date(200_000).toISOString() });
    assert.equal(JSON.stringify(data).includes("do-not-return"), false);
  } finally {
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
