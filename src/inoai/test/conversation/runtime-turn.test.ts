import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "../../../test/sqlite-store.js";

import { RuntimeFailure } from "../../agent-runtime/ports.js";
import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { createSession, listEvents, openDatabase, upsertUser } from "../../connectors/persistence/sqlite/legacy-database.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { runRuntimeTurn } from "../../conversation/runtime-turn.js";

async function withSession(check: (database: ReturnType<typeof openDatabase>, sessionId: number) => Promise<void>): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "inoai-retry-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(project));
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "message", agent_provider: "codex", agent_session_id: "thread", project_path: project });
      await check(database, session.id);
    } finally { database.close(); }
  } finally { await rm(project, { recursive: true, force: true }); }
}

function fakeRuntime(run: (attempt: number) => AsyncIterable<RuntimeEvent>, displayName = "Codex", loginHint = "codex login"): AgentRuntime & { attempts: number } {
  return {
    displayName, loginHint,
    attempts: 0,
    async createSession() { return "thread"; },
    async resumeSession() {},
    runTurn() { return run(++this.attempts); },
    async cancel() {},
    health() { return { state: "ready" }; },
    async close() {},
  };
}

test("only proven-safe attempts retry, at most three times, and report one final outcome", async () => {
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* () { throw new RuntimeFailure("pre_start", true); });
    const outcome = await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question");
    assert.deepEqual({ state: outcome.state, attempts: outcome.attempts, replaySafe: outcome.replaySafe }, { state: "failed", attempts: 3, replaySafe: true });
    assert.equal(runtime.attempts, 3);
    assert.equal(listEvents(database, sessionId).filter((event) => event.event_type === "runtime_failure").length, 3);
    assert.match(outcome.state === "failed" ? outcome.notice : "", /fresh request/);
  });
});

test("uncertain failure after possible side effect never replays or publishes partial answer", async () => {
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* () {
      yield { type: "progress", text: "partial" };
      yield { type: "answer", text: "not confirmed" };
      throw new Error("token=secret-123 raw tool trace");
    });
    const progress: string[] = [];
    const outcome = await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question", (text) => progress.push(text));
    assert.equal(runtime.attempts, 1);
    assert.deepEqual(progress, ["partial"]);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.replaySafe, false);
    assert.match(outcome.state === "failed" ? outcome.notice : "", /fresh request/);
    assert.equal(JSON.stringify(listEvents(database, sessionId)).includes("secret-123"), false);
    assert.equal(listEvents(database, sessionId).filter((event) => event.event_type === "runtime_completed").length, 0);
  });
});

test("safe transient recovery returns exactly one confirmed answer; auth and usage do not retry", async () => {
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* (attempt) {
      if (attempt === 1) throw new RuntimeFailure("pre_start", true);
      yield { type: "answer", text: "done" };
    });
    assert.deepEqual(await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question"), { state: "completed", answer: "done", attempts: 2, replaySafe: false });
    for (const kind of ["authentication", "usage", "cancelled", "timed_out", "session_missing"] as const) {
      const failed = fakeRuntime(async function* () { throw new RuntimeFailure(kind); });
      const result = await runRuntimeTurn(sqliteStore(database), failed, sessionId, "thread", "question");
      assert.equal(result.state, "failed");
      assert.equal(result.state === "failed" ? result.reason : "", kind);
      assert.equal(failed.attempts, 1);
    }
  });
});

test("failure notices name the runtime and its login hint", async () => {
  await withSession(async (database, sessionId) => {
    const notice = async (kind: RuntimeFailure["kind"], displayName?: string, loginHint?: string) => {
      const result = await runRuntimeTurn(sqliteStore(database), fakeRuntime(async function* () { throw new RuntimeFailure(kind); }, displayName, loginHint), sessionId, "thread", "question");
      return result.state === "failed" ? result.notice : "";
    };
    assert.deepEqual(await Promise.all((["authentication", "usage", "pre_start", "timed_out", "cancelled", "uncertain"] as const).map((kind) => notice(kind))), [
      "Codex sign-in needs attention. Run codex login locally, then send a fresh request.",
      "Codex usage is unavailable. Check your account locally, then send a fresh request.",
      "Codex could not start the turn. Please send a fresh request.",
      "Codex timed out; its outcome is uncertain. Please send a fresh request.",
      "Codex turn was cancelled. Please send a fresh request if needed.",
      "Codex turn ended without a confirmed answer. Please send a fresh request.",
    ]);
    assert.equal(await notice("authentication", "Claude", "claude /login"), "Claude sign-in needs attention. Run claude /login locally, then send a fresh request.");
    assert.equal(await notice("uncertain", "Claude", "claude /login"), "Claude turn ended without a confirmed answer. Please send a fresh request.");
    assert.equal(await notice("session_missing", "Claude", "claude /login"), "This thread's Claude session could not be found. Use /inoai reset to start a new session.");
    const overridden = async (kind: RuntimeFailure["kind"]) => {
      const runtime = { ...fakeRuntime(async function* () { throw new RuntimeFailure(kind); }, "OpenCode", "opencode auth login"), authenticationNotice: "Fixed OpenCode authentication notice." };
      const result = await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question");
      return result.state === "failed" ? result.notice : "";
    };
    assert.equal(await overridden("authentication"), "Fixed OpenCode authentication notice.");
    assert.equal(await overridden("usage"), "OpenCode usage is unavailable. Check your account locally, then send a fresh request.");
  });
});

const usageDetails = (database: ReturnType<typeof openDatabase>, sessionId: number) =>
  listEvents(database, sessionId).filter((event) => event.event_type === "runtime_usage").map((event) => ({ detail: event.detail, actor: event.created_by, message_id: event.message_id }));

test("runtime usage is summed per attempt and recorded once after the attempt finishes", async () => {
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* () {
      yield { type: "usage", inputTokens: 1000, outputTokens: 300, cachedInputTokens: 800, costUsd: 0.01 };
      yield { type: "usage", inputTokens: 200, outputTokens: 40, reasoningTokens: 0, costUsd: 0.0023 };
      yield { type: "answer", text: "done" };
    });
    assert.equal((await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question", undefined, null)).state, "completed");
    assert.deepEqual(usageDetails(database, sessionId), [{ detail: "input=1200; output=340; cached=800; reasoning=0; cost_usd=0.0123; provider=codex", actor: "runtime", message_id: null }]);
    const types = listEvents(database, sessionId).map((event) => event.event_type);
    assert.ok(types.indexOf("runtime_usage") > types.indexOf("runtime_completed"));
  });
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* () { yield { type: "usage", outputTokens: 5 }; yield { type: "answer", text: "done" }; });
    await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question");
    assert.deepEqual(usageDetails(database, sessionId).map((event) => event.detail), ["output=5; provider=codex"]);
  });
});

test("attempts without valid usage write no usage event and keep their outcome", async () => {
  await withSession(async (database, sessionId) => {
    const none = fakeRuntime(async function* () { yield { type: "answer", text: "done" }; });
    assert.equal((await runRuntimeTurn(sqliteStore(database), none, sessionId, "thread", "question")).state, "completed");
    const invalid = fakeRuntime(async function* () {
      yield { type: "usage", inputTokens: -1, outputTokens: 1.5, cachedInputTokens: Number.NaN, reasoningTokens: Number.POSITIVE_INFINITY, costUsd: -0.1 };
      yield { type: "usage", costUsd: Number.NaN };
      yield { type: "answer", text: "done" };
    });
    assert.deepEqual(await runRuntimeTurn(sqliteStore(database), invalid, sessionId, "thread", "question"), { state: "completed", answer: "done", attempts: 1, replaySafe: false });
    assert.deepEqual(usageDetails(database, sessionId), []);
    const mixed = fakeRuntime(async function* () { yield { type: "usage", inputTokens: 7, outputTokens: -3, costUsd: Number.POSITIVE_INFINITY }; yield { type: "answer", text: "done" }; });
    await runRuntimeTurn(sqliteStore(database), mixed, sessionId, "thread", "question");
    assert.deepEqual(usageDetails(database, sessionId).map((event) => event.detail), ["input=7; provider=codex"]);
  });
});

test("failed attempts record usage reported before failing without changing the failure", async () => {
  await withSession(async (database, sessionId) => {
    const runtime = fakeRuntime(async function* (attempt) {
      yield { type: "usage", inputTokens: 10 * attempt };
      if (attempt === 1) throw new RuntimeFailure("pre_start", true);
      throw new RuntimeFailure("authentication");
    });
    const outcome = await runRuntimeTurn(sqliteStore(database), runtime, sessionId, "thread", "question");
    assert.deepEqual({ state: outcome.state, reason: outcome.state === "failed" ? outcome.reason : "", attempts: outcome.attempts }, { state: "failed", reason: "authentication", attempts: 2 });
    assert.deepEqual(usageDetails(database, sessionId).map((event) => event.detail), ["input=10; provider=codex", "input=20; provider=codex"]);
  });
});

test("a failed usage write does not change completed or failed outcomes", async () => {
  await withSession(async (database, sessionId) => {
    const base = sqliteStore(database);
    const store = { ...base, createEvent: async (input: Parameters<typeof base.createEvent>[0], actor: string) => {
      if (input.event_type === "runtime_usage") throw new Error("disk full");
      return base.createEvent(input, actor);
    } };
    const completed = fakeRuntime(async function* () { yield { type: "usage", inputTokens: 1 }; yield { type: "answer", text: "done" }; });
    assert.deepEqual(await runRuntimeTurn(store, completed, sessionId, "thread", "question"), { state: "completed", answer: "done", attempts: 1, replaySafe: false });
    const failed = fakeRuntime(async function* () { yield { type: "usage", inputTokens: 1 }; throw new RuntimeFailure("usage"); });
    const outcome = await runRuntimeTurn(store, failed, sessionId, "thread", "question");
    assert.deepEqual({ state: outcome.state, reason: outcome.state === "failed" ? outcome.reason : "" }, { state: "failed", reason: "usage" });
    assert.deepEqual(usageDetails(database, sessionId), []);
  });
});
