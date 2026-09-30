import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeFailure } from "../agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime.js";
import { createSession, listEvents, openDatabase, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import { runRuntimeTurn } from "../runtime-turn.js";

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

function fakeRuntime(run: (attempt: number) => AsyncIterable<RuntimeEvent>): AgentRuntime & { attempts: number } {
  return {
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
    const outcome = await runRuntimeTurn(database, runtime, sessionId, "thread", "question");
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
    const outcome = await runRuntimeTurn(database, runtime, sessionId, "thread", "question", (text) => progress.push(text));
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
    assert.deepEqual(await runRuntimeTurn(database, runtime, sessionId, "thread", "question"), { state: "completed", answer: "done", attempts: 2, replaySafe: false });
    for (const kind of ["authentication", "usage", "cancelled", "timed_out"] as const) {
      const failed = fakeRuntime(async function* () { throw new RuntimeFailure(kind); });
      const result = await runRuntimeTurn(database, failed, sessionId, "thread", "question");
      assert.equal(result.state, "failed");
      assert.equal(result.state === "failed" ? result.reason : "", kind);
      assert.equal(failed.attempts, 1);
    }
  });
});
