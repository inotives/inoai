import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RuntimeFailure } from "../agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime.js";
import { ConversationWorker, fixedTurnNotices } from "../conversation-worker.js";
import { archiveMessage, createEvent, createMemoryReview, createSession, listEvents, openDatabase, upsertUser } from "../database.js";
import type { MemoryReviewRecord, MessageRecord } from "../database.js";
import { createCodexRuntime } from "../index.js";
import { MemoryReviewScheduler } from "../memory-review-scheduler.js";
import type { SchedulerClock } from "../memory-review-scheduler.js";
import { OpenCodeRuntime } from "../opencode-runtime.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import type { RuntimeHome } from "../runtime-home.js";

const hour = 3_600_000;
const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, day, hh, mm);
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const notes = '{"notes": "window notes"}';
const final = '{"recap": "A recap.", "actions": []}';
const answer = (prompt: string) => prompt.includes("combine the window notes") ? final : notes;

function fakeClock(start: Date) {
  let time = start.getTime();
  const timers = new Set<() => void>();
  const clock: SchedulerClock = {
    now: () => new Date(time),
    setInterval: (callback) => { timers.add(callback); return callback; },
    clearInterval: (handle) => { timers.delete(handle as () => void); },
  };
  return { clock, timers, set(date: Date) { time = date.getTime(); }, advance(ms: number) { time += ms; }, tick() { for (const timer of timers) timer(); } };
}

// A review method driven by the test: "ok" answers, "fail" throws a replay-safe failure, "block" waits for the abort.
function reviewRuntime() {
  const state = { mode: "ok" as "ok" | "fail" | "block", calls: 0, signals: [] as AbortSignal[] };
  const runtime: AgentRuntime = {
    displayName: "Claude", loginHint: "claude /login",
    async createSession() { return "claude-new"; }, async resumeSession() {},
    async *runTurn(): AsyncGenerator<RuntimeEvent> { yield { type: "answer", text: "chat answer" }; },
    async cancel() {}, health: () => ({ state: "ready" as const }), async close() {},
    async review(prompt, options) {
      state.calls++;
      if (options?.signal) state.signals.push(options.signal);
      if (state.mode === "fail") throw new RuntimeFailure("usage", true);
      if (state.mode === "block") {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new RuntimeFailure("cancelled", true);
      }
      return answer(prompt);
    },
  };
  return { runtime, state };
}

type Archive = Awaited<ReturnType<typeof seed>>;

async function withHome(fn: (home: RuntimeHome, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-review-scheduler-"));
  try { await fn(await bootstrapRuntimeHome(directory), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function withArchive(fn: (archive: Archive) => Promise<void>): Promise<void> {
  await withHome(async (home, directory) => {
    const database = openDatabase(home);
    try { await fn(await seed(database, directory, home)); } finally { database.close(); }
  });
}

async function seed(database: DatabaseSync, directory: string, home: RuntimeHome) {
  const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
  let count = 0;
  const newSession = () => createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
    parent_conversation_id: "channel", conversation_id: `thread-${++count}`, initiating_external_message_id: `start-${count}`,
    agent_provider: "claude", agent_session_id: `claude-${count}`, project_path: directory });
  const session = newSession();
  const chat = newSession();
  const add = (direction: "user" | "agent", body: string, state: MessageRecord["state"] = "completed", sessionId = session.id) => archiveMessage(database, {
    session_id: sessionId, transport: "discord", workspace_id: "guild", external_message_id: `message-${++count}`,
    external_author_id: direction === "user" ? "owner" : null, user_id: direction === "user" ? owner.id : null,
    direction, body, reply_to_external_message_id: null, in_reply_to_message_id: null, state,
  }).message!;
  const reviews = (sessionId = session.id) => database.prepare("SELECT * FROM memory_reviews WHERE session_id = ? ORDER BY id").all(sessionId) as MemoryReviewRecord[];
  const events = (type: string) => listEvents(database).filter((event) => event.event_type === type).map((event) => event.detail);
  // A user Message in the chat Session, pending until settled.
  const chatMessage = () => {
    const message = add("user", "chat work", "pending", chat.id);
    return { settle: () => { database.prepare("UPDATE messages SET state = 'completed' WHERE id = ?").run(message.id); } };
  };
  return { database, directory, home, owner, session, chat, newSession, add, reviews, events, chatMessage };
}

function scheduler(database: DatabaseSync, runtime: AgentRuntime, clock: SchedulerClock) {
  return new MemoryReviewScheduler(database, runtime, { reviewTime: "06:00", maxChars: 20_000, clock });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

test("no cycle runs before the review time; one cycle per local date across restarts; a missed time is caught up at startup", async () => {
  await withHome(async (home, directory) => {
    const time = fakeClock(at(3, 5, 59));
    const { runtime, state } = reviewRuntime();
    let database = openDatabase(home);
    const archive = await seed(database, directory, home);
    const rows = () => database.prepare("SELECT * FROM memory_reviews WHERE session_id = ? ORDER BY id").all(archive.session.id) as MemoryReviewRecord[];
    const cycles = () => listEvents(database).filter((event) => event.event_type === "memory_review_cycle").map((event) => event.detail);
    const first = archive.add("user", "Please remember that I like tabs.");
    archive.add("agent", "Noted.");
    let instance = scheduler(database, runtime, time.clock);
    instance.start();
    await instance.idle();
    assert.deepEqual([cycles(), rows(), state.calls], [[], [], 0]);
    time.set(at(3, 6, 0));
    time.tick();
    await instance.idle();
    assert.deepEqual(cycles(), ["date=2026-10-03; enqueued=1"]);
    assert.deepEqual(rows().map(({ state, from_message_id }) => [state, from_message_id]), [["completed", first.id]]);
    const calls = state.calls;
    assert.ok(calls > 0);
    await instance.stop();
    database.close();

    // Restart later the same day: the date already has its cycle, so new Messages wait for tomorrow.
    database = openDatabase(home);
    const later = archiveMessage(database, { session_id: archive.session.id, transport: "discord", workspace_id: "guild", external_message_id: "later",
      external_author_id: "owner", user_id: archive.owner.id, direction: "user", body: "Another day's news.", reply_to_external_message_id: null,
      in_reply_to_message_id: null, state: "completed" }).message!;
    time.set(at(3, 23, 0));
    instance = scheduler(database, runtime, time.clock);
    instance.start();
    time.tick();
    await instance.idle();
    assert.equal(cycles().length, 1);
    assert.equal(rows().length, 1);
    assert.equal(state.calls, calls);
    await instance.stop();
    database.close();

    // Started the next day after the time: the cycle catches up once at startup.
    database = openDatabase(home);
    time.set(at(4, 9, 30));
    instance = scheduler(database, runtime, time.clock);
    instance.start();
    await instance.idle();
    time.tick();
    await instance.idle();
    assert.deepEqual(cycles(), ["date=2026-10-03; enqueued=1", "date=2026-10-04; enqueued=1"]);
    assert.deepEqual(rows().map(({ state, from_message_id, through_message_id }) => [state, from_message_id, through_message_id]).at(-1), ["completed", later.id, later.id]);
    await instance.stop();
    database.close();
  });
});

test("a user Message at the scheduled time runs first; the cycle and the review start once chat is idle", async () => {
  await withArchive(async ({ database, add, reviews, events, chatMessage, newSession }) => {
    const time = fakeClock(at(3, 6, 0));
    const { runtime, state } = reviewRuntime();
    add("user", "Remember that the CI runs on Fridays.");
    const chat = chatMessage();
    // A pending Message in an ended Session can never be claimed, so it does not hold reviews back.
    const ended = newSession();
    add("user", "stranded", "pending", ended.id);
    database.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(ended.id);
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    await instance.idle();
    // While chat is busy the daily cycle does not run either: no enqueue transaction inside a chat wake.
    assert.deepEqual([reviews().length, events("memory_review_cycle"), state.calls], [0, [], 0]);
    instance.poke();
    assert.equal(reviews().length, 0);
    chat.settle();
    instance.poke();
    await instance.idle();
    // The settled chat Session now has a completed Message too, so both Sessions are enqueued.
    assert.deepEqual(events("memory_review_cycle"), ["date=2026-10-03; enqueued=2"]);
    assert.deepEqual(reviews().map(({ state, attempts }) => [state, attempts]), [["completed", 0]]);
    await instance.stop();
  });
});

test("chat arriving through the worker preempts a review without using an attempt, and reviews never send to Discord", async () => {
  await withArchive(async ({ database, home, add, reviews, events, chat }) => {
    const time = fakeClock(at(3, 7, 0));
    const { runtime, state } = reviewRuntime();
    state.mode = "block";
    add("user", "Remember that the CI runs on Fridays.");
    const sent: string[] = [];
    const transport = { async sendMessage(_conversation: string, text: string) { sent.push(text); return `sent-${sent.length}`; } };
    const worker = new ConversationWorker(database, home, runtime, "claude", () => {}, transport);
    const instance = scheduler(database, runtime, time.clock);
    worker.onQueueChange(() => instance.poke());
    instance.start();
    await until(() => state.calls === 1);
    assert.equal(reviews()[0].state, "processing");
    add("user", "a chat request", "pending", chat.id);
    worker.wake();
    assert.equal(state.signals[0].aborted, true);
    // Once the chat Turn settles the worker wakes again and the review restarts and completes.
    state.mode = "ok";
    await worker.idle();
    await until(() => reviews()[0].state === "completed");
    await instance.idle();
    assert.equal(state.calls, 3);
    assert.deepEqual(reviews().map(({ state, attempts }) => [state, attempts]), [["completed", 0]]);
    assert.deepEqual(events("memory_review_deferred"), [`review=${reviews()[0].id}; date=2026-10-03; deferrals=1`]);
    assert.deepEqual(sent, ["chat answer"]);
    await instance.stop();
    await worker.stop();
  });
});

test("after five deferrals in a day the review waits for the next cycle", { timeout: 10_000 }, async () => {
  await withArchive(async ({ add, reviews, events, chatMessage, database }) => {
    const time = fakeClock(at(3, 8, 0));
    const { runtime, state } = reviewRuntime();
    state.mode = "block";
    add("user", "Remember that the CI runs on Fridays.");
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    for (let deferral = 1; deferral <= 5; deferral++) {
      await until(() => state.calls === deferral);
      const chat = chatMessage();
      instance.poke();
      await until(() => reviews()[0].state === "pending");
      chat.settle();
      instance.poke();
    }
    await instance.idle();
    assert.equal(state.calls, 5);
    assert.equal(events("memory_review_deferred").length, 5);
    assert.deepEqual(reviews().map(({ state, attempts, next_attempt_at }) => [state, attempts, next_attempt_at]), [["pending", 0, seconds(at(4, 6, 0))]]);
    time.advance(2 * hour);
    time.tick();
    await instance.idle();
    assert.equal(state.calls, 5);
    // The next cycle re-arms the same row; no duplicate is created.
    state.mode = "ok";
    time.set(at(4, 6, 0));
    time.tick();
    await instance.idle();
    assert.deepEqual(reviews().map(({ state }) => state), ["completed"]);
    await instance.stop();
  });
});

test("failed attempts retry after 1, 2, and 4 hours, then stay failed until the next cycle re-arms the same row", async () => {
  await withArchive(async ({ add, reviews, database }) => {
    const start = at(3, 6, 0);
    const time = fakeClock(start);
    const { runtime, state } = reviewRuntime();
    state.mode = "fail";
    add("user", "Remember that the CI runs on Fridays.");
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    await instance.idle();
    const row = () => reviews()[0];
    assert.deepEqual([row().state, row().attempts, row().failure_detail, row().next_attempt_at], ["pending", 1, "usage", seconds(start) + 3600]);
    time.advance(hour - 60_000);
    time.tick();
    await instance.idle();
    assert.equal(row().attempts, 1);
    time.advance(60_000);
    time.tick();
    await instance.idle();
    assert.deepEqual([row().attempts, row().next_attempt_at], [2, seconds(start) + 3 * 3600]);
    time.advance(2 * hour);
    time.tick();
    await instance.idle();
    assert.deepEqual([row().attempts, row().next_attempt_at], [3, seconds(start) + 7 * 3600]);
    time.advance(4 * hour);
    time.tick();
    await instance.idle();
    assert.deepEqual([row().state, row().attempts, row().failure_detail], ["failed", 4, "usage"]);
    const calls = state.calls;
    time.advance(6 * hour);
    time.tick();
    await instance.idle();
    assert.equal(state.calls, calls);
    state.mode = "ok";
    time.set(at(4, 6, 0));
    time.tick();
    await instance.idle();
    assert.deepEqual(reviews().map(({ state, attempts }) => [state, attempts]), [["completed", 0]]);
    await instance.stop();
  });
});

test("a thrown commit error is a failed, replay-safe attempt", async () => {
  await withArchive(async ({ add, reviews, database }) => {
    const time = fakeClock(at(3, 6, 0));
    const { runtime } = reviewRuntime();
    add("user", "Remember that the CI runs on Fridays.");
    database.exec("CREATE TEMP TRIGGER fail_recap BEFORE UPDATE OF recap ON memory_reviews BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    await instance.idle();
    assert.deepEqual(reviews().map(({ state, attempts, failure_detail, recap }) => [state, attempts, failure_detail, recap]), [["pending", 1, "commit_error", null]]);
    database.exec("DROP TRIGGER fail_recap");
    time.advance(hour);
    time.tick();
    await instance.idle();
    assert.equal(reviews()[0].state, "completed");
    await instance.stop();
  });
});

test("a range past the window cap completes in part and a follow-up row reviews the rest in the same cycle", async () => {
  await withArchive(async ({ add, reviews, database }) => {
    const time = fakeClock(at(3, 6, 0));
    const { runtime } = reviewRuntime();
    // One Message per 500-character window; the engine stops at 60 windows.
    const messages = Array.from({ length: 65 }, (_, index) => add("user", `${index} ${"x".repeat(450)}`));
    const instance = new MemoryReviewScheduler(database, runtime, { reviewTime: "06:00", maxChars: 500, clock: time.clock });
    instance.start();
    await until(() => reviews().length === 2 && reviews()[1].state === "completed");
    await instance.idle();
    const [first, second] = reviews();
    assert.deepEqual([first.state, first.from_message_id, first.through_message_id], ["completed", messages[0].id, messages[59].id]);
    assert.deepEqual([second.state, second.from_message_id, second.through_message_id], ["completed", messages[60].id, messages[64].id]);
    await instance.stop();
  });
});

test("a stale processing review returns to pending on restart without using an attempt", async () => {
  await withHome(async (home, directory) => {
    let database = openDatabase(home);
    const archive = await seed(database, directory, home);
    const message = archive.add("user", "Remember that the CI runs on Fridays.");
    const row = createMemoryReview(database, { session_id: archive.session.id, from_message_id: message.id, through_message_id: message.id });
    database.prepare("UPDATE memory_reviews SET state = 'processing', attempts = 1, next_attempt_at = 0 WHERE id = ?").run(row.id);
    createEvent(database, { session_id: null, message_id: null, event_type: "memory_review_cycle", detail: "date=2026-10-03; enqueued=1" });
    database.close();
    database = openDatabase(home);
    try {
      const read = () => database.prepare("SELECT * FROM memory_reviews WHERE id = ?").get(row.id) as MemoryReviewRecord;
      assert.deepEqual([read().state, read().attempts], ["pending", 1]);
      const { runtime } = reviewRuntime();
      const instance = scheduler(database, runtime, fakeClock(at(3, 12, 0)).clock);
      instance.start();
      await instance.idle();
      assert.deepEqual([read().state, read().attempts], ["completed", 1]);
      await instance.stop();
    } finally { database.close(); }
  });
});

test("a stale row is replaced with the current range; an empty range completes without a Recap", async () => {
  await withArchive(async ({ add, reviews, database, newSession, events, session }) => {
    const time = fakeClock(at(3, 12, 0));
    createEvent(database, { session_id: null, message_id: null, event_type: "memory_review_cycle", detail: "date=2026-10-03; enqueued=0" });
    const [m1, m2] = [add("user", "Remember that the CI runs on Fridays."), add("agent", "Noted.")];
    const stale = createMemoryReview(database, { session_id: session.id, from_message_id: m2.id, through_message_id: m2.id });
    database.prepare("UPDATE memory_reviews SET next_attempt_at = 0 WHERE id = ?").run(stale.id);
    const { runtime, state } = reviewRuntime();
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    await until(() => reviews().some((row) => row.state === "completed"));
    await instance.idle();
    assert.deepEqual(reviews().map(({ id, state, from_message_id, through_message_id, deleted_at }) => [id === stale.id, state, from_message_id, through_message_id, deleted_at !== null]),
      [[true, "failed", m2.id, m2.id, true], [false, "completed", m1.id, m2.id, false]]);
    await instance.stop();

    // Only a failed request and its fixed notice: nothing to review, but the cursor moves on.
    const other = newSession();
    add("user", "a failed request", "failed", other.id);
    const notice = add("agent", fixedTurnNotices[0], "completed", other.id);
    const calls = state.calls;
    const next = scheduler(database, runtime, fakeClock(at(4, 6, 0)).clock);
    next.start();
    await next.idle();
    assert.deepEqual(reviews(other.id).map(({ state, recap, through_message_id }) => [state, recap, through_message_id]), [["completed", null, notice.id]]);
    assert.equal(state.calls, calls);
    assert.ok(events("memory_review_completed").some((detail) => detail?.endsWith("empty=1")));
    await next.stop();
  });
});

test("Codex and OpenCode homes record one skip per cycle and leave cursors unchanged", async () => {
  await withArchive(async ({ add, database, events }) => {
    add("user", "Remember that the CI runs on Fridays.");
    const runtimes = [createCodexRuntime({} as never), new OpenCodeRuntime({ executable: join(tmpdir(), "inoai-missing-opencode-cli") })];
    for (const [index, runtime] of runtimes.entries()) {
      const time = fakeClock(at(3 + index, 6, 0));
      const instance = scheduler(database, runtime, time.clock);
      instance.start();
      time.tick();
      await instance.idle();
      await instance.stop();
    }
    assert.deepEqual(events("memory_review_skipped"), ["date=2026-10-03; reason=unsupported_runtime", "date=2026-10-04; reason=unsupported_runtime"]);
    assert.deepEqual(events("memory_review_cycle"), ["date=2026-10-03; enqueued=0", "date=2026-10-04; enqueued=0"]);
    assert.deepEqual(database.prepare("SELECT * FROM memory_reviews").all(), []);
  });
});

test("shutdown aborts an active review and waits for it to settle without using an attempt", async () => {
  await withArchive(async ({ add, reviews, events, database }) => {
    const time = fakeClock(at(3, 6, 0));
    const { runtime, state } = reviewRuntime();
    state.mode = "block";
    add("user", "Remember that the CI runs on Fridays.");
    const instance = scheduler(database, runtime, time.clock);
    instance.start();
    await until(() => state.calls === 1);
    await instance.stop();
    assert.equal(state.signals[0].aborted, true);
    assert.deepEqual(reviews().map(({ state, attempts }) => [state, attempts]), [["pending", 0]]);
    assert.deepEqual(events("memory_review_deferred"), []);
    assert.equal(time.timers.size, 0);
    instance.poke();
    assert.equal(state.calls, 1);
  });
});
