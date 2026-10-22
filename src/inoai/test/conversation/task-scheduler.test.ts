import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeFailure } from "../../agent-runtime/ports.js";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import { TaskScheduler } from "../../conversation/task-scheduler.js";
import { MemoryReviewScheduler } from "../../memory/memory-review-scheduler.js";
import type { SchedulerClock } from "../../memory/memory-review-scheduler.js";

function fakeClock(initial: number) {
  let now = initial;
  const timers = new Set<() => void>();
  const clock: SchedulerClock = {
    now: () => new Date(now * 1000),
    setInterval: (callback, ms) => { assert.equal(ms, 60_000); timers.add(callback); return callback; },
    clearInterval: (handle) => { timers.delete(handle as () => void); },
  };
  return { clock, now: () => now, set(value: number) { now = value; }, tick() { for (const timer of timers) timer(); } };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

async function withStore(fn: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-scheduler-"));
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  const store = createSqliteOperationalStore(database);
  try { await fn(await fixture(directory, home, store)); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

async function fixture(directory: string, home: Awaited<ReturnType<typeof bootstrapRuntimeHome>>,
  store: ReturnType<typeof createSqliteOperationalStore>) {
  const owner = await store.upsertUser({ transport: "discord", workspace_id: "guild", external_user_id: "owner",
    display_name: null, role: "owner", state: "active" });
  assert.ok(owner);
  let count = 0;
  async function task(type: "one_time" | "recurring", due?: number) {
    const thread = `task-${++count}`;
    const session = await store.createSession({ user_id: owner!.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: thread, initiating_external_message_id: `start-${count}`,
      agent_provider: "codex", agent_session_id: `pending:${thread}`, project_path: directory });
    const record = await store.createTask({ goal: `Goal ${count}`, task_type: type,
      interval_seconds: type === "recurring" ? 3600 : undefined, next_due_at: due,
      conversation_id: thread, session_id: session.id });
    return { task: record, session };
  }
  return { directory, home, store, owner, task };
}

test("recurring due checks use interval completion times and skip one-time or paused Tasks", async () => {
  await withStore(async ({ home, store, task }) => {
    const time = fakeClock(10_000);
    const recurring = await task("recurring", 13_600);
    await task("one_time");
    let turns = 0;
    const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
      createSession: async () => `session-${++turns}`, resumeSession: async () => {}, cancel: async () => {},
      health: () => ({ state: "ready" }), close: async () => {},
      async *runTurn(): AsyncIterable<RuntimeEvent> { yield { type: "answer", text: "Done" }; } };
    const runner = new TaskRunExecutor(store, runtime, home, { sendMessage: async () => "sent" },
      { reserveTaskRun: async () => () => {} }, "codex", { now: time.now });
    const scheduler = new TaskScheduler(store, runner, time.clock);
    runner.onSettled(() => { void scheduler.poke(); });
    scheduler.start();
    await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 0);
    time.set(13_599); time.tick(); await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 0);
    time.set(13_600); time.tick();
    await until(async () => (await store.listTaskRuns(recurring.task.id))[0]?.state === "completed");
    assert.equal((await store.getTask(recurring.task.id))?.next_due_at, 17_200);
    assert.equal((await store.listTasks()).filter((row) => row.task_type === "one_time")[0]?.state, "active");
    time.tick(); await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 1);
    await store.pauseTask(recurring.task.id);
    time.set(17_200); time.tick(); await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 1);
    await store.resumeTask(recurring.task.id);
    time.tick();
    await until(async () => (await store.listTaskRuns(recurring.task.id))[1]?.state === "completed");
    assert.equal((await store.getTask(recurring.task.id))?.next_due_at, 20_800);
    assert.equal(await runner.cancel(recurring.task.id), true);
    time.set(20_800); time.tick(); await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 2);
    await scheduler.stop();
    await runner.stop();
  });
});

test("startup catch-up dispatches due Tasks serially and lets arriving chat run between them", async () => {
  await withStore(async ({ directory, home, store, owner, task }) => {
    const time = fakeClock(100_000);
    const first = await task("recurring", 3_600);
    const second = await task("recurring", 7_200);
    const chat = await store.createSession({ user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "chat", initiating_external_message_id: "chat-start",
      agent_provider: "codex", agent_session_id: "pending:chat", project_path: directory });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
      createSession: async () => `session-${order.length}`, resumeSession: async () => {}, cancel: async () => {},
      health: () => ({ state: "ready" }), close: async () => {},
      async *runTurn(_id, prompt): AsyncIterable<RuntimeEvent> {
        const kind = prompt.includes("Task goal: Goal 1") ? "first" : prompt.includes("Task goal: Goal 2") ? "second" : "chat";
        order.push(kind);
        if (kind === "first") await firstBlocked;
        yield { type: "answer", text: "Done" };
      } };
    const worker = new ConversationWorker(store, home, runtime, "codex");
    const runner = new TaskRunExecutor(store, runtime, home, { sendMessage: async () => "sent" },
      worker, "codex", { now: time.now });
    const scheduler = new TaskScheduler(store, runner, time.clock);
    runner.onSettled(() => { void scheduler.poke(); });
    worker.onQueueChange(() => { void scheduler.poke(); });
    scheduler.start();
    await until(async () => order.includes("first"));
    assert.equal((await store.listTaskRuns(second.task.id)).length, 0);
    await store.archiveMessage({ session_id: chat.id, transport: "discord", workspace_id: "guild",
      external_message_id: "chat-message", external_author_id: "owner", user_id: owner.id,
      direction: "user", body: "Chat first", reply_to_external_message_id: null,
      in_reply_to_message_id: null, state: "pending" });
    void worker.wake();
    assert.deepEqual(order, ["first"]);
    releaseFirst();
    await until(async () => (await store.listTaskRuns(second.task.id))[0]?.state === "completed");
    assert.deepEqual(order, ["first", "chat", "second"]);
    assert.equal((await store.getTask(first.task.id))?.next_due_at, 103_600);
    assert.equal((await store.getTask(second.task.id))?.next_due_at, 103_600);
    assert.equal((await store.listTaskRuns(first.task.id)).length, 1);
    await scheduler.stop(); await runner.stop(); await worker.idle();
  });
});

test("failed and restart-interrupted runs wait for the next interval without replay", async () => {
  await withStore(async ({ home, store, task }) => {
    const time = fakeClock(50_000);
    const recurring = await task("recurring", 1_000);
    let turns = 0;
    const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
      createSession: async () => "session", resumeSession: async () => {}, cancel: async () => {},
      health: () => ({ state: "ready" }), close: async () => {},
      async *runTurn(): AsyncIterable<RuntimeEvent> { turns++; throw new Error("provider detail"); } };
    const runner = new TaskRunExecutor(store, runtime, home, { sendMessage: async () => "sent" },
      { reserveTaskRun: async () => () => {} }, "codex", { now: time.now });
    const scheduler = new TaskScheduler(store, runner, time.clock);
    runner.onSettled(() => { void scheduler.poke(); });
    scheduler.start();
    await until(async () => (await store.listTaskRuns(recurring.task.id))[0]?.state === "failed");
    assert.equal(turns, 1);
    assert.equal((await store.getTask(recurring.task.id))?.next_due_at, 53_600);
    time.tick(); await scheduler.poke();
    assert.equal((await store.listTaskRuns(recurring.task.id)).length, 1);
    time.set(53_600); time.tick();
    await until(async () => (await store.listTaskRuns(recurring.task.id))[1]?.state === "failed");
    assert.equal(turns, 2);
    await scheduler.stop(); await runner.stop();

    const interrupted = await task("recurring", 1_000);
    const claimed = await store.claimTaskRun(interrupted.task.id, 54_000);
    assert.ok(claimed);
    await store.recoverTaskRuns("startup-recovery", 100_000);
    assert.equal((await store.getTaskRun(claimed.id))?.state, "failed");
    assert.equal((await store.getTask(interrupted.task.id))?.next_due_at, 103_600);
    assert.equal((await store.getTask(interrupted.task.id))?.state, "active");
  });
});

test("a Task waits for an in-flight Memory Review and holds later reviews until it settles", async () => {
  await withStore(async ({ directory, home, store, owner, task }) => {
    const time = fakeClock(100_000);
    const scheduled = await task("recurring", 1_000);
    const memorySession = await store.createSession({ user_id: owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "memory-thread", initiating_external_message_id: "memory-start",
      agent_provider: "codex", agent_session_id: "memory-session", project_path: directory });
    await store.archiveMessage({ session_id: memorySession.id, transport: "discord", workspace_id: "guild",
      external_message_id: "memory-user", external_author_id: "owner", user_id: owner.id,
      direction: "user", body: "Remember the report topic", reply_to_external_message_id: null,
      in_reply_to_message_id: null, state: "completed" });
    await store.archiveMessage({ session_id: memorySession.id, transport: "discord", workspace_id: "guild",
      external_message_id: "memory-agent", external_author_id: null, user_id: null,
      direction: "agent", body: "Remembered", reply_to_external_message_id: null,
      in_reply_to_message_id: null, state: "completed" });
    const order: string[] = [];
    let reviewing = false;
    let taskRunning = false;
    let overlap = false;
    let reviewCalls = 0;
    let finishTask!: () => void;
    const taskBlocked = new Promise<void>((resolve) => { finishTask = resolve; });
    const runtime: AgentRuntime = { displayName: "fake", loginHint: "none",
      createSession: async () => "task-session", resumeSession: async () => {}, cancel: async () => {},
      health: () => ({ state: "ready" }), close: async () => {},
      async *runTurn(): AsyncIterable<RuntimeEvent> {
        overlap ||= reviewing;
        taskRunning = true;
        order.push("task-start");
        await taskBlocked;
        yield { type: "answer", text: "Done" };
        taskRunning = false;
      },
      async review(_prompt, options) {
        reviewCalls++;
        overlap ||= taskRunning;
        if (order.includes("review-stop")) throw new RuntimeFailure("usage", true);
        reviewing = true;
        order.push("review-start");
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        reviewing = false;
        order.push("review-stop");
        throw new RuntimeFailure("cancelled", true);
      },
    };
    const memory = new MemoryReviewScheduler(store, runtime, { reviewTime: "00:00", maxChars: 20_000, clock: time.clock });
    memory.start();
    await until(async () => order.includes("review-start"));
    const runner = new TaskRunExecutor(store, runtime, home, { sendMessage: async () => "sent" },
      { reserveTaskRun: async () => () => {} }, "codex",
      { now: time.now, pauseReview: () => memory.pauseForTask() });
    assert.equal(await runner.start(scheduled.task.id), "started");
    await until(async () => order.includes("task-start"));
    await memory.poke();
    assert.equal(reviewCalls, 1);
    finishTask();
    await until(async () => (await store.listTaskRuns(scheduled.task.id))[0]?.state === "completed");
    await runner.stop();
    await memory.stop();
    assert.equal(overlap, false);
    assert.deepEqual(order.slice(0, 3), ["review-start", "review-stop", "task-start"]);
  });
});
