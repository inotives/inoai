import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bootstrapRuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { nextRunAt, type TaskSpec } from "../../inoai/tasks/schedule.js";
import { renderAppShell } from "../pages/app-shell.js";
import { launchUi, uiTokenHeader } from "../server.js";

type WriteResult = { ok: boolean; status: number; task?: any; error?: string; fields?: Record<string, string>; retryable?: boolean };
type TaskClient = {
  taskWrite: (method: string, path: string, body?: unknown) => Promise<WriteResult>;
  previewRuns: (spec: unknown, now: number, runsSoFar?: number, count?: number) => number[];
  localInputToUnix: (value: string, tz: string) => number | null;
  unixToLocalInput: (unix: number, tz: string) => string;
  saveTask: (task: unknown, spec: Record<string, unknown>) => Promise<WriteResult>;
};
type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };

const pageScript = (html: string) => html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";

// Runs the page's own task client section with a stub document and fetch.
function taskClient(html: string, token: string, fetchImpl: (url: string, init: any) => Promise<Response>): TaskClient {
  const script = pageScript(html);
  const start = script.indexOf("// ---------- task client");
  const end = script.indexOf("// ---------- end task client ----------");
  assert.ok(start > 0 && end > start, "page has a task client section");
  const document = { querySelector: (selector: string) => selector === 'meta[name="inoai-ui-token"]' ? { getAttribute: () => token } : null };
  return new Function("document", "fetch", `${script.slice(start, end)}\nreturn { taskWrite, previewRuns, localInputToUnix, unixToLocalInput, saveTask };`)(document, fetchImpl) as TaskClient;
}

function getPage(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path }, (reply) => {
      let text = "";
      reply.setEncoding("utf8");
      reply.on("data", (chunk) => { text += chunk; });
      reply.on("end", () => resolve(text));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("Tasks drawer has the form, controls, run history viewer, and no innerHTML", () => {
  const html = renderAppShell("ab".repeat(32));
  const script = pageScript(html);
  assert.doesNotThrow(() => new Function(`return async () => {${script}}`), "page script must parse");
  for (const text of ["'New task'", "'Instruction (required)'", "'Expected output'", "'Title'", "'Next runs · '", "'Time zone'", "'Until (optional)'",
    "'Run limit (optional)'", "'Edit'", "'Run now'", "'Pause'", "'Resume'", "'Cancel task'", "'Are you sure? Cancel stops future runs.",
    "'Yes, cancel task'", "'Changes run when the agent is running.'", "'Run history · '", "' · result.md'", "Intl.supportedValuesOf('timeZone')",
    "'x-inoai-token'", "'content-type': 'application/json'", "' and read-only.'"]) {
    assert.ok(html.includes(text), `page includes ${text}`);
  }
  for (const [value] of [["now"], ["at"], ["interval"], ["daily"], ["days"], ["weekly"]]) assert.ok(html.includes(`['${value}', '`), `schedule option ${value}`);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), false, "the page never parses HTML from data");
  assert.match(html, /@media \(max-width:640px\)\{\.drawer\{[^}]*width:100%/, "the drawer fills a narrow screen");
  assert.match(html, /\.row2\{grid-template-columns:minmax\(0,1fr\)\}/, "paired fields stack at phone width");
  assert.equal(html.includes(".env"), false);
});

test("the page preview matches the server's next runs across time zones and DST", () => {
  const client = taskClient(renderAppShell("ab".repeat(32)), "ab".repeat(32), () => Promise.reject(new Error("no network")));
  const base = { title: "t", instruction: "i", expectedOutput: null, endsAt: null, maxRuns: null };
  const springForward = Date.UTC(2026, 2, 7, 12) / 1000; // the day before New York skips 02:00-03:00
  const fallBack = Date.UTC(2026, 9, 31, 12) / 1000; // the day before New York repeats 01:00-02:00
  const specs: Array<[TaskSpec, number]> = [
    [{ ...base, schedule: { kind: "interval", hours: 5 }, timezone: "UTC" }, springForward],
    [{ ...base, schedule: { kind: "daily", time: "02:30" }, timezone: "America/New_York" }, springForward],
    [{ ...base, schedule: { kind: "daily", time: "01:30" }, timezone: "America/New_York" }, fallBack],
    [{ ...base, schedule: { kind: "days", time: "09:00", days: ["mon", "wed", "fri"] }, timezone: "Asia/Singapore" }, fallBack],
    [{ ...base, schedule: { kind: "weekly", time: "23:45", day: "sun" }, timezone: "Australia/Sydney" }, springForward],
    [{ ...base, schedule: { kind: "daily", time: "08:00" }, timezone: "Europe/London", maxRuns: 2 }, fallBack],
    [{ ...base, schedule: { kind: "daily", time: "08:00" }, timezone: "Europe/London", endsAt: fallBack + 2 * 86400 }, fallBack],
    [{ ...base, schedule: { kind: "once", at: fallBack + 600 }, timezone: "UTC" }, fallBack],
  ];
  for (const [spec, now] of specs) {
    const server: number[] = [];
    let after = now;
    for (let runs = 0; runs < 3; runs += 1) {
      const next = nextRunAt(spec, after, runs);
      if (next === null) break;
      server.push(next);
      after = next;
    }
    assert.deepEqual(client.previewRuns(spec, now, 0, 3), server, JSON.stringify(spec.schedule) + " " + spec.timezone);
  }
  // datetime-local values are read in the selected time zone.
  assert.equal(client.localInputToUnix("2026-11-01T01:30", "America/New_York"), Date.UTC(2026, 10, 1, 5, 30) / 1000);
  assert.equal(client.localInputToUnix("2026-03-08T02:30", "America/New_York"), Date.UTC(2026, 2, 8, 7, 0) / 1000);
  assert.equal(client.unixToLocalInput(Date.UTC(2026, 9, 23, 1, 5) / 1000, "Asia/Singapore"), "2026-10-23T09:05");
  assert.equal(client.localInputToUnix("", "UTC"), null);
});

test("task form and controls work end to end against the UI server on a demo home", async () => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-task-e2e-"));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-demo");
  const database = openDatabase(home);
  database.prepare("INSERT INTO users (transport, workspace_id, external_user_id, role) VALUES ('discord', 'guild', 'owner', 'owner')").run();
  database.prepare(`INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id,
    agent_provider, agent_session_id, project_path) VALUES (1, 'discord', 'guild', 'channel', 'thread-1', 'm-1', 'codex', 'agent-1', ?)`).run(deploymentDirectory);
  database.close();
  // Any route that read `.env` would fail on this unreadable file.
  await chmod(home.envFile, 0o000);
  const ui = await launchUi(deploymentDirectory, ".inoai-connect-demo", 0);
  const origin = `http://127.0.0.1:${ui.port}`;
  const calls: FetchCall[] = [];
  // Acts like the browser: same-origin requests carry the page's Origin.
  const browserFetch = (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    return fetch(origin + url, { ...init, headers: { ...init.headers, origin } });
  };
  const sql = (text: string, ...values: Array<string | number | null>) => {
    const db = new DatabaseSync(home.databaseFile);
    try { return db.prepare(text).run(...values); } finally { db.close(); }
  };
  const uiData = async () => (await fetch(origin + "/api/ui-data")).json() as Promise<any>;
  try {
    const html = await getPage(ui.port, "/");
    const token = /<meta name="inoai-ui-token" content="([0-9a-f]{64})">/.exec(html)?.[1];
    assert.ok(token);

    // Without the token, the page sends nothing.
    const tokenless = taskClient(html, "", browserFetch);
    const refused = await tokenless.taskWrite("POST", "/api/tasks", {});
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /no write token/);
    assert.equal(calls.length, 0);

    const client = taskClient(html, token, browserFetch);
    const spec = (overrides: Record<string, unknown> = {}) => ({ title: "Weekly CI", instruction: "Summarize failing CI", expectedOutput: "A Markdown list",
      schedule: { kind: "weekly", time: "09:00", day: "mon" }, timezone: "Asia/Singapore", endsAt: null, maxRuns: null, ...overrides });

    // Field errors come back per field.
    const invalid = await client.taskWrite("POST", "/api/tasks", spec({ instruction: "", schedule: { kind: "interval", hours: 0 }, timezone: "Mars/Base" }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.fields!).sort(), ["instruction", "schedule.hours", "timezone"]);
    assert.equal(calls[0]!.headers[uiTokenHeader], token);
    assert.equal(calls[0]!.headers["content-type"], "application/json");
    assert.equal(calls[0]!.method, "POST");

    // Create.
    const created = await client.taskWrite("POST", "/api/tasks", spec());
    assert.equal(created.status, 201);
    const id = created.task.id as number;
    assert.equal(created.task.scheduleLabel, "weekly on Monday at 09:00 (Asia/Singapore)");
    assert.deepEqual(JSON.parse(calls[1]!.body), spec());

    // Edit.
    const edited = await client.taskWrite("PATCH", `/api/tasks/${id}`, spec({ title: "Daily CI", schedule: { kind: "days", time: "08:30", days: ["mon", "fri"] }, maxRuns: 5 }));
    assert.equal(edited.status, 200);
    assert.equal(edited.task.title, "Daily CI");
    assert.equal(edited.task.scheduleLabel, "Mon, Fri at 08:30 (Asia/Singapore), up to 5 runs");
    assert.equal(calls[2]!.method, "PATCH");

    // Run now, pause, resume.
    const before = Math.floor(Date.now() / 1000);
    const ran = await client.taskWrite("POST", `/api/tasks/${id}/run`);
    assert.equal(ran.status, 200);
    assert.ok(Date.parse(ran.task.nextDueAt) / 1000 >= before && Date.parse(ran.task.nextDueAt) / 1000 <= before + 5);
    assert.equal((await client.taskWrite("POST", `/api/tasks/${id}/pause`)).task.state, "paused");
    const pausedRun = await client.taskWrite("POST", `/api/tasks/${id}/run`);
    assert.deepEqual([pausedRun.status, pausedRun.error], [409, "Only active tasks can run now."]);
    assert.equal((await client.taskWrite("POST", `/api/tasks/${id}/resume`)).task.state, "active");

    // While a run is processing, edit is refused and the row shows it.
    sql("INSERT INTO task_runs (task_id, state, started_at) VALUES (?, 'processing', ?)", id, before);
    const busyEdit = await client.taskWrite("PATCH", `/api/tasks/${id}`, spec());
    assert.deepEqual([busyEdit.status, busyEdit.error], [409, "A run is in progress. Try again after it finishes."]);
    let data = await uiData();
    assert.equal(data.tasks.find((x: any) => x.id === id).runs.lastState, "processing");
    assert.equal(data.taskRuns[0].resultNote, "Run in progress");

    // Run history carries result.md text, redacted; unsafe or large files are refused.
    sql("UPDATE task_runs SET state='completed', completed_at=? WHERE task_id=?", before + 30, id);
    const runIds = [1, 2, 3, 4, 5];
    for (const [index, runId] of runIds.slice(1).entries()) {
      sql("INSERT INTO task_runs (task_id, state, started_at, completed_at, failure_detail) VALUES (?, ?, ?, ?, ?)",
        id, index === 2 ? "failed" : "completed", before + 100 * (index + 1), before + 100 * (index + 1) + 10, index === 2 ? "Runtime failed" : null);
    }
    const folder = (runId: number) => join(home.directory, "results", String(id), String(runId));
    for (const runId of runIds) await mkdir(folder(runId), { recursive: true });
    await writeFile(join(folder(1), "result.md"), "# CI report\n\n- build failed\nTOKEN=do-not-return\n", "utf8");
    const outside = join(deploymentDirectory, "outside.md");
    await writeFile(outside, "outside secret", "utf8");
    await symlink(outside, join(folder(2), "result.md"));
    await writeFile(join(folder(3), "result.md"), "x".repeat(64 * 1024 + 1), "utf8");
    const hardTarget = join(deploymentDirectory, "hard-target.md");
    await writeFile(hardTarget, "hard link secret", "utf8");
    await link(hardTarget, join(folder(5), "result.md"));
    data = await uiData();
    const history = data.taskRuns.filter((run: any) => run.taskId === id);
    assert.deepEqual(history.map((run: any) => run.id), [5, 4, 3, 2, 1], "newest run first");
    const byId = new Map(history.map((run: any) => [run.id, run]));
    assert.equal((byId.get(1) as any).result, "# CI report\n\n- build failed\nTOKEN=[redacted]\n");
    assert.deepEqual([(byId.get(2) as any).result, (byId.get(2) as any).resultNote], [null, "result.md is unavailable"]);
    assert.deepEqual([(byId.get(3) as any).result, (byId.get(3) as any).resultNote], [null, "result.md is larger than 64 KB"]);
    assert.deepEqual([(byId.get(4) as any).state, (byId.get(4) as any).result, (byId.get(4) as any).resultNote, (byId.get(4) as any).failureDetail],
      ["failed", null, "No result.md", "Runtime failed"]);
    assert.deepEqual([(byId.get(5) as any).result, (byId.get(5) as any).resultNote], [null, "result.md is unavailable"], "a hard link is refused");
    const text = JSON.stringify(data);
    assert.equal(text.includes("do-not-return") || text.includes("outside secret") || text.includes("hard link secret"), false);
    assert.equal(data.profile.status, "stopped", "the page shows the stopped-agent notice");

    // Cancel. Cancelled tasks are read-only.
    const cancelled = await client.taskWrite("POST", `/api/tasks/${id}/cancel`);
    assert.equal(cancelled.task.state, "cancelled");
    const lateEdit = await client.taskWrite("PATCH", `/api/tasks/${id}`, spec());
    assert.deepEqual([lateEdit.status, lateEdit.error], [409, "Only active or paused tasks can be edited."]);
    assert.equal((await client.taskWrite("POST", `/api/tasks/${id}/resume`)).status, 409);

    // Once, now.
    const now = await client.taskWrite("POST", "/api/tasks", spec({ title: "Now", schedule: { kind: "once" } }));
    assert.deepEqual([now.status, now.task.taskType, now.task.scheduleKind], [201, "one_time", "once"]);
    // An edit that still holds redacted text sends no PATCH; re-entered text is saved as typed.
    const raw = "Check the API uses bearer auth and summarise the token: usage";
    const secretive = await client.taskWrite("POST", "/api/tasks", spec({ title: "Auth", instruction: raw, schedule: { kind: "interval", hours: 3 } }));
    assert.equal(secretive.status, 201);
    const shown = (await uiData()).tasks.find((x: any) => x.id === secretive.task.id);
    assert.deepEqual(shown.redactedFields, ["instruction"]);
    assert.notEqual(shown.goal, raw);
    const unchanged = { title: shown.title, instruction: shown.goal, expectedOutput: shown.outputSpec, schedule: { kind: "daily", time: "07:00" },
      timezone: shown.timezone, endsAt: null, maxRuns: null };
    const callsBefore = calls.length;
    const blocked = await client.saveTask(shown, unchanged);
    assert.deepEqual([blocked.ok, blocked.status, Object.keys(blocked.fields!)], [false, 0, ["instruction"]]);
    assert.equal(calls.length, callsBefore, "no PATCH is sent");
    const saved = await client.saveTask(shown, { ...unchanged, instruction: raw });
    assert.deepEqual([saved.ok, calls.at(-1)!.method], [true, "PATCH"]);
    const stored = new DatabaseSync(home.databaseFile, { readOnly: true });
    try {
      assert.deepEqual({ ...(stored.prepare("SELECT goal, schedule_kind AS kind FROM tasks WHERE id=?").get(secretive.task.id) as object) }, { goal: raw, kind: "daily" });
    } finally { stored.close(); }
    assert.equal(JSON.stringify(await uiData()).includes(raw), false, "raw text never reaches the UI");
    assert.ok(calls.every((call) => call.headers[uiTokenHeader] === token && call.headers["content-type"] === "application/json"), "every write carries the token and JSON");
  } finally {
    await new Promise<void>((resolve) => ui.server.close(() => resolve()));
    await chmod(home.envFile, 0o600);
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
});
