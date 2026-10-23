import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { noSessionMessage } from "../api/task-writes.js";
import { launchUi, uiTokenHeader } from "../server.js";

type Reply = { status: number; body: any; text: string };
type Send = (method: string, path: string, body?: unknown, headers?: Record<string, string | undefined>) => Promise<Reply>;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const spec = (overrides: Record<string, unknown> = {}) => ({
  title: "CI summary", instruction: "Summarize failing CI", expectedOutput: "A Markdown list",
  schedule: { kind: "interval", hours: 2 }, timezone: "Asia/Singapore", ...overrides,
});

function httpRequest(port: number, method: string, path: string, headers: Record<string, string>, payload?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers }, (reply) => {
      let text = "";
      reply.setEncoding("utf8");
      reply.on("data", (chunk) => { text += chunk; });
      reply.on("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* HTML */ }
        resolve({ status: reply.statusCode ?? 0, body, text });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

async function withUi(name: string, run: (context: { home: RuntimeHome; send: Send; token: string; port: number }) => Promise<void>,
  options: { session?: boolean } = {}): Promise<void> {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), `inoai-ui-writes-${name}-`));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  const database = openDatabase(home);
  database.prepare("INSERT INTO users (transport, workspace_id, external_user_id, role) VALUES ('discord', 'guild', 'owner', 'owner')").run();
  if (options.session !== false) {
    database.prepare(`INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id,
      agent_provider, agent_session_id, project_path) VALUES (1, 'discord', 'guild', 'channel', 'thread-1', 'm-1', 'claude', 'agent-1', ?)`).run(deploymentDirectory);
  }
  database.close();
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

function query<T>(home: RuntimeHome, sql: string, ...values: Array<string | number>): T[] {
  const database = new DatabaseSync(home.databaseFile, { readOnly: true });
  try { return database.prepare(sql).all(...values) as T[]; } finally { database.close(); }
}

function snapshot(home: RuntimeHome): string {
  return JSON.stringify([query(home, "SELECT * FROM sessions ORDER BY id"), query(home, "SELECT * FROM tasks ORDER BY id"), query(home, "SELECT * FROM task_runs ORDER BY id")]);
}

test("UI create writes a placeholder session and a task with ui:owner audit fields", async () => {
  await withUi("create", async ({ home, send }) => {
    const before = nowSeconds();
    const created = await send("POST", "/api/tasks", spec());
    assert.equal(created.status, 201);
    const task = created.body.task;
    assert.equal(task.title, "CI summary");
    assert.equal(task.goal, "Summarize failing CI");
    assert.equal(task.outputSpec, "A Markdown list");
    assert.equal(task.scheduleKind, "interval");
    assert.equal(task.timezone, "Asia/Singapore");
    assert.equal(task.state, "active");
    const due = Date.parse(task.nextDueAt) / 1000;
    assert.ok(due >= before + 7200 && due <= nowSeconds() + 7200);

    const [row] = query<Record<string, unknown>>(home, "SELECT * FROM tasks WHERE id=?", task.id);
    assert.equal(row!.created_by, "ui:owner");
    assert.equal(row!.updated_by, "ui:owner");
    assert.match(String(row!.conversation_id), /^pending:ui:[0-9a-f-]{36}$/);
    const [session] = query<Record<string, unknown>>(home, "SELECT * FROM sessions WHERE id=?", Number(row!.session_id));
    assert.equal(session!.conversation_id, row!.conversation_id);
    assert.equal(session!.initiating_external_message_id, row!.conversation_id);
    assert.equal(session!.parent_conversation_id, "pending:ui");
    assert.match(String(session!.agent_session_id), /^pending:task:[0-9a-f-]{36}$/);
    assert.deepEqual([session!.user_id, session!.transport, session!.workspace_id, session!.agent_provider, session!.state, session!.created_by],
      [1, "discord", "guild", "claude", "active", "ui:owner"]);

    // A second create gets its own unique placeholder ids.
    assert.equal((await send("POST", "/api/tasks", spec({ title: "Second" }))).status, 201);
    assert.equal(query<{ count: number }>(home, "SELECT COUNT(DISTINCT conversation_id) AS count FROM sessions WHERE conversation_id LIKE 'pending:ui:%'")[0]!.count, 2);

    // Reads still work and carry the new task columns.
    const data = (await send("GET", "/api/ui-data")).body;
    assert.equal(data.tasks.length, 2);
    assert.deepEqual(Object.keys(data.tasks[0]).sort(), ["createdAt", "endsAt", "goal", "id", "intervalSeconds", "maxRuns", "nextDueAt", "outputSpec", "redactedFields",
      "runs", "scheduleDays", "scheduleKind", "scheduleLabel", "scheduleTime", "state", "taskType", "timezone", "title", "updatedAt"]);
  });
});

test("UI create returns 409 with a clear message when the home has no session", async () => {
  await withUi("no-session", async ({ home, send }) => {
    const reply = await send("POST", "/api/tasks", spec());
    assert.equal(reply.status, 409);
    assert.deepEqual(reply.body, { error: noSessionMessage });
    assert.equal(noSessionMessage, "Talk to the agent in Discord once before creating tasks from the UI.");
    assert.equal(query(home, "SELECT * FROM sessions").length, 0);
    assert.equal(query(home, "SELECT * FROM tasks").length, 0);
  }, { session: false });
});

test("UI edit, run now, pause, resume, and cancel update the task and its audit fields", async () => {
  await withUi("actions", async ({ home, send }) => {
    const id = (await send("POST", "/api/tasks", spec())).body.task.id as number;
    const audit = () => query<{ updated_by: string; next_due_at: number; state: string; title: string; schedule_kind: string; schedule_time: string | null;
      schedule_days: string | null; task_type: string; interval_seconds: number | null }>(home, "SELECT * FROM tasks WHERE id=?", id)[0]!;

    const edited = await send("PATCH", `/api/tasks/${id}`, spec({ title: "Weekly CI", schedule: { kind: "weekly", day: "mon", time: "09:00" }, timezone: "America/New_York" }));
    assert.equal(edited.status, 200);
    assert.equal(edited.body.task.title, "Weekly CI");
    let row = audit();
    assert.deepEqual([row.schedule_kind, row.schedule_time, row.schedule_days, row.task_type, row.interval_seconds, row.updated_by],
      ["weekly", "09:00", "mon", "recurring", 86400, "ui:owner"]);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(row.next_due_at * 1000));
    assert.equal(local, "Mon 09:00", "edit recomputes next_due_at for the new schedule");

    const before = nowSeconds();
    assert.equal((await send("POST", `/api/tasks/${id}/run`)).status, 200);
    row = audit();
    assert.ok(row.next_due_at >= before && row.next_due_at <= nowSeconds(), "run now sets next_due_at to now");

    assert.equal((await send("POST", `/api/tasks/${id}/pause`, {})).body.task.state, "paused");
    assert.equal(audit().updated_by, "ui:owner");
    assert.equal((await send("POST", `/api/tasks/${id}/pause`, {})).status, 409);
    assert.equal((await send("POST", `/api/tasks/${id}/run`)).status, 409, "run now needs an active task");

    // Edit works on a paused task.
    assert.equal((await send("PATCH", `/api/tasks/${id}`, spec({ schedule: { kind: "interval", hours: 3 } }))).status, 200);
    const beforeResume = nowSeconds();
    const resumed = await send("POST", `/api/tasks/${id}/resume`, {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.task.state, "active");
    row = audit();
    assert.ok(row.next_due_at >= beforeResume + 3 * 3600 && row.next_due_at <= nowSeconds() + 3 * 3600, "resume recomputes from now");
    assert.equal(row.updated_by, "ui:owner");
    assert.equal((await send("POST", `/api/tasks/${id}/resume`, {})).status, 409);

    // A processing run blocks edit and run now; cancel leaves the run untouched.
    const database = new DatabaseSync(home.databaseFile);
    database.prepare("INSERT INTO task_runs (task_id, state, started_at) VALUES (?, 'processing', ?)").run(id, nowSeconds());
    database.close();
    const busy = await send("PATCH", `/api/tasks/${id}`, spec());
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, "A run is in progress. Try again after it finishes.");
    assert.equal((await send("POST", `/api/tasks/${id}/run`)).status, 409);
    const cancelled = await send("POST", `/api/tasks/${id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.state, "cancelled");
    assert.equal(audit().updated_by, "ui:owner");
    assert.deepEqual(query<object>(home, "SELECT state, completed_at FROM task_runs WHERE task_id=?", id).map((run) => ({ ...run })), [{ state: "processing", completed_at: null }]);

    // Cancelled tasks are read-only.
    for (const [method, path] of [["PATCH", `/api/tasks/${id}`], ["POST", `/api/tasks/${id}/run`], ["POST", `/api/tasks/${id}/pause`],
      ["POST", `/api/tasks/${id}/resume`], ["POST", `/api/tasks/${id}/cancel`]] as const) {
      assert.equal((await send(method, path, spec())).status, 409, `${method} ${path}`);
    }
    assert.equal((await send("POST", "/api/tasks/9999/pause", {})).status, 404);
  });
});

test("UI writes reject invalid input with 400 and write nothing", async () => {
  await withUi("invalid", async ({ home, send }) => {
    const id = (await send("POST", "/api/tasks", spec())).body.task.id as number;
    const before = snapshot(home);
    const invalid = await send("POST", "/api/tasks", spec({ title: "", timezone: "Mars/Base", schedule: { kind: "interval", hours: 0 } }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "Invalid task.");
    assert.deepEqual(Object.keys(invalid.body.fields).sort(), ["schedule.hours", "timezone", "title"]);
    assert.equal((await send("PATCH", `/api/tasks/${id}`, spec({ schedule: { kind: "daily", time: "25:00" } }))).status, 400);
    assert.equal((await send("POST", "/api/tasks", "{not json")).status, 400);
    assert.equal(snapshot(home), before);
  });
});

test("UI writes reject bad Origin, Host, content type, token, and body size with 403 and write nothing", async () => {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (message: string) => { warnings.push(message); });
  try {
    await withUi("security", async ({ home, send, token, port }) => {
      const before = snapshot(home);
      const cases: Array<[string, Record<string, string | undefined>, string?]> = [
        ["missing origin", { origin: undefined }],
        ["wrong origin", { origin: "http://evil.example" }],
        ["wrong origin port", { origin: `http://127.0.0.1:${port + 1}` }],
        ["wrong host", { host: `evil.example:${port}` }],
        ["non-JSON", { "content-type": "text/plain" }],
        ["form", { "content-type": "application/x-www-form-urlencoded" }],
        ["missing token", { [uiTokenHeader]: undefined }],
        ["wrong token", { [uiTokenHeader]: "0".repeat(64) }],
        ["short token", { [uiTokenHeader]: token.slice(0, 10) }],
        ["oversized body", {}, JSON.stringify(spec({ instruction: "x".repeat(33 * 1024) }))],
        ["oversized chunked body", { "transfer-encoding": "chunked" }, JSON.stringify(spec({ instruction: "x".repeat(40 * 1024) }))],
      ];
      for (const [label, headers, body] of cases) {
        const reply = await send("POST", "/api/tasks", body ?? spec(), headers);
        assert.equal(reply.status, 403, label);
        assert.deepEqual(reply.body, { error: "Forbidden." }, label);
        const action = await send("POST", "/api/tasks/1/cancel", body ?? {}, headers);
        assert.equal(action.status, 403, `${label} on an action`);
      }
      assert.equal(snapshot(home), before);
      // localhost is the server's own origin too.
      const local = await send("POST", "/api/tasks", spec(), { host: `localhost:${port}`, origin: `http://localhost:${port}` });
      assert.equal(local.status, 201);
      assert.ok(warnings.length >= cases.length * 2);
      assert.ok(warnings.every((line) => /^ui task write rejected: POST \/api\/tasks(?:\/1\/cancel)? [a-z-]+$/.test(line)), warnings.join("\n"));
      assert.equal(warnings.some((line) => line.includes(token)), false);
    });
  } finally {
    warn.mock.restore();
  }
});

test("UI write returns a retryable error when the database stays busy", async () => {
  await withUi("busy", async ({ home, send }) => {
    const before = snapshot(home);
    const holder = new DatabaseSync(home.databaseFile);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      const reply = await send("POST", "/api/tasks", spec());
      const elapsed = Date.now() - started;
      assert.equal(reply.status, 503);
      assert.deepEqual(reply.body, { error: "The database is busy. Try again.", retryable: true });
      assert.ok(elapsed >= 4_500 && elapsed < 15_000, `waited ${elapsed} ms`);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    assert.equal(snapshot(home), before);
    assert.equal((await send("POST", "/api/tasks", spec())).status, 201, "a retry succeeds once the database is free");
  });
});
