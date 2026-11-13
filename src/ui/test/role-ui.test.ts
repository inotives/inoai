import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { loadUiData } from "../api/read-model.js";
import { launchUi, uiTokenHeader } from "../server.js";

type Reply = { status: number; body: any; text: string; allow?: string };
type Send = (method: string, path: string, body?: unknown, headers?: Record<string, string | undefined>) => Promise<Reply>;

const validRole = (name: string) => `# Role: ${name}\n\nA short summary.\n\n## Instructions\n\nDo the work.\n\n## Workflow\n\n1. Start.\n`;

function httpRequest(port: number, method: string, path: string, headers: Record<string, string>, payload?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers }, (reply) => {
      let text = "";
      reply.setEncoding("utf8");
      reply.on("data", (chunk) => { text += chunk; });
      reply.on("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: reply.statusCode ?? 0, body, text, allow: reply.headers.allow });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

async function withUi(name: string, run: (context: { home: RuntimeHome; send: Send; token: string; port: number }) => Promise<void>): Promise<void> {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), `inoai-ui-roles-${name}-`));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  openDatabase(home).close();
  // Any route that read `.env` would fail on this unreadable file.
  await chmod(home.envFile, 0o000);
  const ui = await launchUi(deploymentDirectory, ".inoai-connect-test", 0);
  try {
    const page = await httpRequest(ui.port, "GET", "/", {});
    const token = /<meta name="inoai-ui-token" content="([0-9a-f]{64})">/.exec(page.text)?.[1];
    assert.ok(token, "page carries the per-launch token");
    const send: Send = (method, path, body, headers = {}) => {
      const merged: Record<string, string | undefined> = {
        origin: `http://127.0.0.1:${ui.port}`, "content-type": "application/json", [uiTokenHeader]: token, ...headers,
      };
      const clean = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as Record<string, string>;
      return httpRequest(ui.port, method, path, clean, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    };
    await run({ home, send, token, port: ui.port });
  } finally {
    await new Promise<void>((resolve) => ui.server.close(() => resolve()));
    await chmod(home.envFile, 0o600);
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
}

type EquipRow = { id: number; role_id: string; equipped_by: string; unequipped_at: number | null; unequipped_by: string | null; created_by: string; updated_by: string };

function rows(home: RuntimeHome): EquipRow[] {
  const database = new DatabaseSync(home.databaseFile, { readOnly: true });
  try { return database.prepare("SELECT * FROM role_equips ORDER BY id").all() as EquipRow[]; } finally { database.close(); }
}

function write(home: RuntimeHome, sql: string): void {
  const database = new DatabaseSync(home.databaseFile);
  try { database.exec(sql); } finally { database.close(); }
}

test("UI equip and unequip write role_equips rows with actor ui:owner", async () => {
  await withUi("equip", async ({ home, send }) => {
    const equipped = await send("POST", "/api/role/equip", { roleId: "planner" });
    assert.equal(equipped.status, 200);
    assert.deepEqual(Object.keys(equipped.body), ["role"]);
    assert.deepEqual(Object.keys(equipped.body.role).sort(), ["id", "name", "reason", "summary", "text", "valid"]);
    assert.equal(equipped.body.role.id, "planner");
    assert.equal(equipped.body.role.valid, true);
    assert.equal(equipped.body.role.reason, null);
    assert.match(equipped.body.role.text, /^# Role: /);
    let [row] = rows(home);
    assert.deepEqual([row!.role_id, row!.equipped_by, row!.created_by, row!.updated_by, row!.unequipped_at], ["planner", "ui:owner", "ui:owner", "ui:owner", null]);

    // Equipping the equipped role succeeds and writes no row.
    assert.equal((await send("POST", "/api/role/equip", { roleId: "planner" })).status, 200);
    assert.equal(rows(home).length, 1);

    // A switch closes the open row and inserts the new one.
    assert.equal((await send("POST", "/api/role/equip", { roleId: "reviewer" })).body.role.id, "reviewer");
    const [closed, open] = rows(home);
    assert.equal(closed!.unequipped_by, "ui:owner");
    assert.equal(closed!.updated_by, "ui:owner");
    assert.ok(closed!.unequipped_at !== null);
    assert.deepEqual([open!.role_id, open!.equipped_by, open!.unequipped_at], ["reviewer", "ui:owner", null]);
    assert.equal((await send("GET", "/api/ui-data")).body.roles.equipped, "reviewer");

    // Unequip accepts an empty body or `{}`, and is a no-op when nothing is equipped.
    const unequipped = await send("POST", "/api/role/unequip");
    assert.equal(unequipped.status, 200);
    assert.deepEqual(unequipped.body, { role: null });
    [, row] = rows(home);
    assert.equal(row!.unequipped_by, "ui:owner");
    const before = JSON.stringify(rows(home));
    assert.deepEqual((await send("POST", "/api/role/unequip", {})).body, { role: null });
    assert.equal(JSON.stringify(rows(home)), before);
    assert.equal(rows(home).length, 2, "rows are never deleted");
    assert.equal((await send("GET", "/api/ui-data")).body.roles.equipped, null);
  });
});

test("UI equip returns 400 for a bad body or id, 404 for an unknown role, and 409 for an invalid file", async () => {
  await withUi("invalid", async ({ home, send }) => {
    for (const body of ["{not json", [], "\"planner\"", {}, { roleId: 7 }, { roleId: "" }, { roleId: "Planner" }, { roleId: "../planner" }, { roleId: "none" }]) {
      const reply = await send("POST", "/api/role/equip", body);
      assert.equal(reply.status, 400, JSON.stringify(body));
    }
    const unknown = await send("POST", "/api/role/equip", { roleId: "ghost" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: "Role not found." });

    await writeFile(join(home.rolesDirectory, "broken.md"), "# Role: Broken\n\nSummary only.\n");
    const broken = await send("POST", "/api/role/equip", { roleId: "broken" });
    assert.equal(broken.status, 409);
    assert.equal(broken.body.error, "Cannot equip role: missing or empty '## Instructions' section");

    await writeFile(join(home.rolesDirectory, "leaky.md"), validRole("Leaky").replace("Do the work.", "Use api_key=abc123 always."));
    const leaky = await send("POST", "/api/role/equip", { roleId: "leaky" });
    assert.equal(leaky.status, 409);
    assert.equal(leaky.body.error, "Cannot equip role: secret-like text");
    assert.equal(leaky.text.includes("abc123"), false);

    await symlink(join(home.rolesDirectory, "planner.md"), join(home.rolesDirectory, "linked.md"));
    assert.equal((await send("POST", "/api/role/equip", { roleId: "linked" })).status, 409);
    assert.equal(rows(home).length, 0);
  });
});

test("UI role writes return 409 for a missing role_equips table or a missing database", async () => {
  await withUi("schema", async ({ home, send }) => {
    write(home, "DROP TABLE role_equips");
    for (const [path, body] of [["/api/role/equip", { roleId: "planner" }], ["/api/role/unequip", {}]] as const) {
      const reply = await send("POST", path, body);
      assert.equal(reply.status, 409, path);
      assert.deepEqual(reply.body, { error: "Start the Agent Instance once to upgrade its database." });
    }
    const data = (await send("GET", "/api/ui-data")).body;
    assert.equal(data.roles.equipped, null, "a database without the table reads as no role");
    assert.equal(data.roles.list.length, 3);

    await rm(home.databaseFile);
    const missing = await send("POST", "/api/role/equip", { roleId: "planner" });
    assert.equal(missing.status, 409);
    assert.deepEqual(missing.body, { error: "Start the agent once before managing roles from the UI." });
    assert.equal(existsSync(home.databaseFile), false, "the UI never creates the database");
  });
});

test("UI role writes reject each failed security check with 403 and log one line without secrets", async () => {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (message: string) => { warnings.push(message); });
  try {
    await withUi("security", async ({ home, send, token, port }) => {
      const cases: Array<[string, Record<string, string | undefined>, string?]> = [
        ["wrong host", { host: `evil.example:${port}` }],
        ["missing origin", { origin: undefined }],
        ["wrong origin", { origin: "http://evil.example" }],
        ["non-JSON", { "content-type": "text/plain" }],
        ["missing token", { [uiTokenHeader]: undefined }],
        ["wrong token", { [uiTokenHeader]: "0".repeat(64) }],
        ["oversized body", {}, JSON.stringify({ roleId: "planner", pad: "x".repeat(33 * 1024) })],
        ["oversized chunked body", { "transfer-encoding": "chunked" }, JSON.stringify({ roleId: "planner", pad: "x".repeat(40 * 1024) })],
      ];
      for (const [label, headers, body] of cases) {
        for (const path of ["/api/role/equip", "/api/role/unequip"]) {
          const reply = await send("POST", path, body ?? { roleId: "planner" }, headers);
          assert.equal(reply.status, 403, `${label} on ${path}`);
          assert.deepEqual(reply.body, { error: "Forbidden." }, `${label} on ${path}`);
        }
      }
      assert.equal(rows(home).length, 0);
      // The check order matches Task writes: a bad Origin is reported before a bad token.
      warnings.length = 0;
      await send("POST", "/api/role/equip", { roleId: "planner" }, { origin: undefined, [uiTokenHeader]: undefined });
      assert.deepEqual(warnings, ["ui role write rejected: POST /api/role/equip origin"]);
      warnings.length = 0;
      await send("POST", "/api/role/equip", { roleId: "planner" }, { "content-type": "text/plain", [uiTokenHeader]: undefined });
      assert.deepEqual(warnings, ["ui role write rejected: POST /api/role/equip content-type"]);

      // localhost is the server's own origin too.
      const local = await send("POST", "/api/role/equip", { roleId: "planner" }, { host: `localhost:${port}`, origin: `http://localhost:${port}` });
      assert.equal(local.status, 200);
      warnings.length = 0;
      for (const [label, headers, body] of cases) await send("POST", "/api/role/equip", body ?? { roleId: "planner" }, headers).then((reply) => assert.equal(reply.status, 403, label));
      assert.equal(warnings.length, cases.length);
      assert.ok(warnings.every((line) => /^ui role write rejected: POST \/api\/role\/equip [a-z-]+$/.test(line)), warnings.join("\n"));
      assert.equal(warnings.some((line) => line.includes(token) || line.includes("planner")), false);
    });
  } finally {
    warn.mock.restore();
  }
});

test("UI role routes return 405 for a wrong method and 404 for an unknown path", async () => {
  await withUi("routes", async ({ send }) => {
    for (const [method, path] of [["GET", "/api/role/equip"], ["PUT", "/api/role/equip"], ["GET", "/api/role/unequip"], ["DELETE", "/api/role/unequip"]] as const) {
      const reply = await send(method, path);
      assert.equal(reply.status, 405, `${method} ${path}`);
      assert.equal(reply.allow, "POST", `${method} ${path}`);
    }
    for (const path of ["/api/role", "/api/role/", "/api/role/show", "/api/role/equip/planner", "/api/role/equipx"]) {
      const reply = await send("POST", path, {});
      assert.equal(reply.status, 404, path);
      assert.deepEqual(reply.body, { error: "Not found." }, path);
    }
  });
});

test("UI role write returns a retryable 503 when the database stays busy", async () => {
  await withUi("busy", async ({ home, send }) => {
    const holder = new DatabaseSync(home.databaseFile);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      const reply = await send("POST", "/api/role/equip", { roleId: "planner" });
      const elapsed = Date.now() - started;
      assert.equal(reply.status, 503);
      assert.deepEqual(reply.body, { error: "The database is busy. Try again.", retryable: true });
      assert.ok(elapsed >= 4_500 && elapsed < 15_000, `waited ${elapsed} ms`);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    assert.equal(rows(home).length, 0);
    assert.equal((await send("POST", "/api/role/equip", { roleId: "planner" })).status, 200, "a retry succeeds once the database is free");
  });
});

test("UI data lists roles with text only for valid files", async (t) => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-roles-data-"));
  t.after(() => rm(deploymentDirectory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  openDatabase(home).close();
  await writeFile(join(home.rolesDirectory, "broken.md"), "# Role: Broken\n");
  await writeFile(join(home.rolesDirectory, "leaky.md"), validRole("Leaky").replace("Do the work.", "password: hunter2"));
  await writeFile(join(home.rolesDirectory, "Bad_Name.md"), validRole("Bad"));
  await writeFile(join(home.rolesDirectory, "notes.txt"), "ignored");
  await writeFile(join(home.rolesDirectory, "writer.md"), validRole("Writer"));
  write(home, "INSERT INTO role_equips (role_id, equipped_by, created_by, updated_by) VALUES ('writer', 'cli:owner', 'cli:owner', 'cli:owner')");

  const { roles } = await loadUiData(home);
  assert.deepEqual(Object.keys(roles).sort(), ["equipped", "list"]);
  assert.equal(roles.equipped, "writer");
  assert.deepEqual(roles.list.map((role) => role.id), ["Bad_Name", "broken", "designer", "leaky", "planner", "reviewer", "writer"]);
  const writer = roles.list.find((role) => role.id === "writer")!;
  assert.deepEqual(writer, { id: "writer", name: "Writer", summary: "A short summary.", valid: true, reason: null, text: validRole("Writer") });
  for (const role of roles.list.filter((item) => !item.valid)) {
    assert.deepEqual(Object.keys(role).sort(), ["id", "name", "reason", "summary", "valid"], role.id);
    assert.equal(role.name, null);
    assert.equal(role.summary, null);
  }
  assert.equal(roles.list.find((role) => role.id === "leaky")!.reason, "secret-like text");
  assert.equal(JSON.stringify(roles).includes("hunter2"), false);
  assert.equal(roles.list.filter((role) => role.valid).length, 4);
});

test("UI data reports an empty role list without creating a missing roles folder", async (t) => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-roles-missing-"));
  t.after(() => rm(deploymentDirectory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  openDatabase(home).close();
  await rm(home.rolesDirectory, { recursive: true });
  const { roles } = await loadUiData(home);
  assert.deepEqual(roles, { equipped: null, list: [] });
  assert.equal(existsSync(home.rolesDirectory), false);
});
