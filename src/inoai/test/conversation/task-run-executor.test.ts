import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start } from "../../app.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import type { TaskOperationsStore } from "../../connectors/persistence/sqlite/operational-store.js";
import type { OperationalStore } from "../../persistence/operational-store.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

test("manual Task Run claims once, uses its thread cursor, and keeps unique uploaded files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-run-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const task = await store.createTask({ goal: "Make a report", task_type: "recurring", interval_seconds: 3600,
        conversation_id: "thread", session_id: session.id });
      await writeFile(join(directory, "private.txt"), "do not upload");
      const steering = await store.archiveMessage({ session_id: session.id, transport: "discord", workspace_id: "guild",
        external_message_id: "steer", external_author_id: "owner", user_id: instance.owner.id, direction: "user",
        body: "Use Markdown", reply_to_external_message_id: null, in_reply_to_message_id: null, state: "completed" });
      assert.ok(steering.message);
      const prompts: string[] = [];
      const uploads: string[] = [];
      const sent: string[] = [];
      const runtime: AgentRuntime = {
        displayName: "fake", loginHint: "none", createSession: async () => "runtime-session",
        resumeSession: async () => {}, cancel: async () => {}, health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(_id: string, prompt: string): AsyncIterable<RuntimeEvent> {
          prompts.push(prompt);
          const output = prompt.match(/Save only requested files inside (.+?)\. Do not overwrite/)?.[1];
          assert.ok(output);
          await writeFile(join(output, "report.md"), `report ${prompts.length}`);
          await symlink(join(directory, "private.txt"), join(output, "linked.txt"));
          yield { type: "answer", text: "Report ready" };
        },
      };
      const transport = { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; },
        uploadFile: async (_id: string, path: string) => { uploads.push(path); return "uploaded"; } };
      const gate = { reserveTaskRun: async () => () => {} };
      const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome, transport, gate, "codex");
      assert.deepEqual(await store.listTaskRuns(task.id), []);
      assert.equal(await runner.start(task.id), "started");
      await until(async () => {
        const state = (await store.listTaskRuns(task.id))[0]?.state;
        if (state === "failed") throw new Error(`Run failed: ${JSON.stringify(prompts)}`);
        return state === "completed";
      });
      await runner.stop();
      assert.equal((await store.getTask(task.id))?.message_cursor, steering.message.id);
      assert.match(prompts[0]!, /Use Markdown/);
      assert.deepEqual((await store.listTaskRuns(task.id))[0]?.artifact_paths, [`results/${task.id}/1/report.md`]);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0], join(instance.runtimeHome.directory, "results", String(task.id), "1", "report.md"));
      assert.match(sent.join("\n"), /results\/1\/1\/report.md/);
      assert.equal(await readFile(join(instance.runtimeHome.directory, "results", String(task.id), "1", "report.md"), "utf8"), "report 1");
      await assert.rejects(access(join(directory, "results")));

      assert.equal(await runner.start(task.id), "started");
      await until(async () => {
        const state = (await store.listTaskRuns(task.id))[1]?.state;
        if (state === "failed") throw new Error(`Retry failed: ${JSON.stringify(sent)}`);
        return state === "completed";
      });
      await runner.stop();
      assert.doesNotMatch(prompts[1]!, /Use Markdown/);
      assert.equal(await readFile(join(instance.runtimeHome.directory, "results", String(task.id), "1", "report.md"), "utf8"), "report 1");
      assert.equal(await readFile(join(instance.runtimeHome.directory, "results", String(task.id), "2", "report.md"), "utf8"), "report 2");
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed one-time Task waits for manual retry; upload failure keeps local artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-retry-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const task = await store.createTask({ goal: "Make a report", task_type: "one_time", conversation_id: "thread", session_id: session.id });
      let attempts = 0;
      const sent: string[] = [];
      const runtime: AgentRuntime = {
        displayName: "fake", loginHint: "none", createSession: async () => "runtime-session",
        resumeSession: async () => {}, cancel: async () => {}, health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(_id: string, prompt: string): AsyncIterable<RuntimeEvent> {
          attempts++;
          if (attempts === 1) throw new Error("secret=private-provider-detail");
          const output = prompt.match(/Save only requested files inside (.+?)\. Do not overwrite/)?.[1];
          assert.ok(output);
          await writeFile(join(output, "report.html"), "<p>ready</p>");
          yield { type: "answer", text: "Ready" };
        },
      };
      const transport = { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; },
        uploadFile: async () => { throw new Error("network failure"); } };
      const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome, transport,
        { reserveTaskRun: async () => () => {} }, "codex");
      assert.equal(await runner.start(task.id), "started");
      await until(async () => (await store.listTaskRuns(task.id))[0]?.state === "failed");
      assert.equal(attempts, 1);
      assert.equal((await store.getTask(task.id))?.state, "active");
      assert.equal((await store.listTaskRuns(task.id)).length, 1);
      assert.doesNotMatch(sent.join("\n"), /private-provider-detail/);
      await runner.stop();
      assert.equal(await runner.start(task.id), "started");
      await until(async () => (await store.listTaskRuns(task.id))[1]?.state === "completed");
      await runner.stop();
      assert.equal((await store.getTask(task.id))?.state, "completed");
      assert.match(sent.join("\n"), /Upload failed; local file: results\/1\/2\/report.html/);
      assert.equal(await readFile(join(instance.runtimeHome.directory, "results", "1", "2", "report.html"), "utf8"), "<p>ready</p>");
      await assert.rejects(access(join(directory, "results")));
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Task cancellation stops its active runtime and leaves a cancelled run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-cancel-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const task = await store.createTask({ goal: "Wait", task_type: "one_time", conversation_id: "thread", session_id: session.id });
      let cancelled = false;
      let finish!: () => void;
      const blocked = new Promise<void>((resolve) => { finish = resolve; });
      const runtime: AgentRuntime = {
        displayName: "fake", loginHint: "none", createSession: async () => "runtime-session",
        resumeSession: async () => {}, cancel: async () => { cancelled = true; finish(); },
        health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(): AsyncIterable<RuntimeEvent> { await blocked; yield { type: "answer", text: "Too late" }; },
      };
      const transport = { sendMessage: async () => "sent" };
      const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome, transport,
        { reserveTaskRun: async () => () => {} }, "codex");
      assert.equal(await runner.start(task.id), "started");
      await until(async () => (await store.getSession(session.id))?.agent_session_id === "runtime-session");
      assert.equal(await runner.cancel(task.id), true);
      await runner.stop();
      assert.equal(cancelled, true);
      assert.equal((await store.getTask(task.id))?.state, "cancelled");
      assert.equal((await store.listTaskRuns(task.id))[0]?.state, "cancelled");
      assert.equal(await runner.start(task.id), "unavailable");
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("queued chat prevents a manual Task Run claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-chat-priority-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const taskSession = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "task-thread", initiating_external_message_id: "task-starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const chatSession = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "chat-thread", initiating_external_message_id: "chat-starter",
        agent_provider: "codex", agent_session_id: "pending:chat:thread", project_path: directory });
      const task = await store.createTask({ goal: "Wait", task_type: "one_time",
        conversation_id: "task-thread", session_id: taskSession.id });
      await store.archiveMessage({ session_id: chatSession.id, transport: "discord", workspace_id: "guild",
        external_message_id: "chat", external_author_id: "owner", user_id: instance.owner.id,
        direction: "user", body: "First", reply_to_external_message_id: null,
        in_reply_to_message_id: null, state: "pending" });
      const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
        createSession: async () => "runtime", resumeSession: async () => {}, cancel: async () => {},
        health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(): AsyncIterable<RuntimeEvent> { yield { type: "answer", text: "Done" }; } };
      const worker = new ConversationWorker(store, instance.runtimeHome, runtime, "codex");
      const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome,
        { sendMessage: async () => "sent" }, worker, "codex");
      assert.equal(await runner.start(task.id), "busy");
      assert.deepEqual(await store.listTaskRuns(task.id), []);
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function withUsageTask(name: string, run: (context: { store: OperationalStore & TaskOperationsStore;
  instance: Awaited<ReturnType<typeof start>>; sessionId: number; taskId: number }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `inoai-task-usage-${name}-`));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const task = await store.createTask({ goal: "Report", task_type: "recurring", interval_seconds: 3600,
        conversation_id: "thread", session_id: session.id });
      await run({ store, instance, sessionId: session.id, taskId: task.id });
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function usageRuntime(turns: RuntimeEvent[][], failOn?: number): AgentRuntime {
  let count = 0;
  return {
    displayName: "fake", loginHint: "none", createSession: async () => "runtime-session",
    resumeSession: async () => {}, cancel: async () => {}, health: () => ({ state: "ready" }), close: async () => {},
    async *runTurn(): AsyncIterable<RuntimeEvent> {
      const turn = count++;
      for (const event of turns[turn] ?? []) yield event;
      if (turn === failOn) throw new Error("turn failed");
    },
  };
}

async function finishRun(store: OperationalStore & TaskOperationsStore, runner: TaskRunExecutor, taskId: number, index: number): Promise<string> {
  assert.equal(await runner.start(taskId), "started");
  let state: string | undefined;
  await until(async () => { state = (await store.listTaskRuns(taskId))[index]?.state; return state === "completed" || state === "failed"; });
  await runner.stop();
  return state!;
}

const usageEvents = async (store: OperationalStore, sessionId: number) => (await store.listEvents(sessionId))
  .filter((event) => event.event_type === "runtime_usage")
  .map((event) => ({ detail: event.detail, actor: event.created_by, message_id: event.message_id }));

test("Task Run sums usage into one runtime_usage event and skips runs without usage", async () => {
  await withUsageTask("sum", async ({ store, instance, sessionId, taskId }) => {
    const sent: string[] = [];
    const runtime = usageRuntime([
      [{ type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
        { type: "usage", inputTokens: 50, cachedInputTokens: 10, reasoningTokens: -1, costUsd: 0.0005 },
        { type: "answer", text: "Done" }],
      [{ type: "usage", inputTokens: Number.NaN }, { type: "answer", text: "Done again" }],
    ]);
    const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome,
      { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; } }, { reserveTaskRun: async () => () => {} }, "codex");
    assert.equal(await finishRun(store, runner, taskId, 0), "completed");
    const expected = [{ detail: "input=150; output=20; cached=10; cost_usd=0.0015; provider=codex", actor: "runtime", message_id: null }];
    assert.deepEqual(await usageEvents(store, sessionId), expected);
    assert.equal(await finishRun(store, runner, taskId, 1), "completed");
    assert.deepEqual(await usageEvents(store, sessionId), expected);
    assert.match(sent.join("\n"), /run #1 completed[\s\S]*run #2 completed/);
  });
});

test("failed Task Run still records reported usage and still fails", async () => {
  await withUsageTask("failed", async ({ store, instance, sessionId, taskId }) => {
    const sent: string[] = [];
    const runtime = usageRuntime([[{ type: "usage", inputTokens: 7, outputTokens: 3 }]], 0);
    const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome,
      { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; } }, { reserveTaskRun: async () => () => {} }, "codex");
    assert.equal(await finishRun(store, runner, taskId, 0), "failed");
    assert.deepEqual(await usageEvents(store, sessionId), [{ detail: "input=7; output=3; provider=codex", actor: "runtime", message_id: null }]);
    assert.match(sent.join("\n"), /run #1 failed/);
  });
});

test("failing runtime_usage write does not change the Task Run outcome", async () => {
  await withUsageTask("write-failure", async ({ store, instance, sessionId, taskId }) => {
    const failing = new Proxy(store, { get(target, property) {
      if (property === "createEvent") {
        return async (event: { event_type: string }, actor?: string) => {
          if (event.event_type === "runtime_usage") throw new Error("disk full");
          return target.createEvent(event as Parameters<typeof target.createEvent>[0], actor);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const sent: string[] = [];
    const runtime = usageRuntime([[{ type: "usage", inputTokens: 5 }, { type: "answer", text: "Done" }]]);
    const runner = new TaskRunExecutor(failing, runtime, instance.runtimeHome,
      { sendMessage: async (_id: string, text: string) => { sent.push(text); return "sent"; } }, { reserveTaskRun: async () => () => {} }, "codex");
    assert.equal(await finishRun(store, runner, taskId, 0), "completed");
    assert.deepEqual(await usageEvents(store, sessionId), []);
    assert.match(sent.join("\n"), /run #1 completed/);
  });
});
