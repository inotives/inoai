import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import type { Configuration } from "../../agent-instance/config.js";
import { RuntimeFailure, reviewInstructions } from "../../agent-runtime/ports.js";
import type { RuntimeEvent, RuntimeFailureKind } from "../../agent-runtime/ports.js";
import { createAnthropicApiClient } from "../../connectors/agent-runtime/anthropic-api-client.js";
import { AnthropicApiRuntime, anthropicApiMaxTokensNotice, anthropicApiRefusalNotice, anthropicApiTools } from "../../connectors/agent-runtime/anthropic-api-runtime.js";
import type { AnthropicApiRuntimeOptions } from "../../connectors/agent-runtime/anthropic-api-runtime.js";
import { openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { addUsage, runtimeFailureNotice } from "../../conversation/runtime-turn.js";
import type { Usage } from "../../conversation/runtime-turn.js";
import { reviewSessionWithStore } from "../../memory/memory-review.js";
import type { MemoryReviewCommit, MemoryReviewSnapshot } from "../../persistence/operational-store.js";

const sentinelKey = "sk-ant-api03-SENTINEL-runtime-do-not-print";
const model = "claude-opus-5-5";

// ---- Fake Messages API ----

type Block = Record<string, unknown>;
type Reply = { status?: number; body?: unknown; sse?: string[]; hang?: string[]; error?: true };
type Call = { body: Record<string, unknown>; headers: Headers };

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function streamed(content: Block[], stopReason: string, usage = { input: 10, created: 2, read: 3, output: 5 }, iterations?: Block[]): string[] {
  const events = [sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.created, cache_read_input_tokens: usage.read, output_tokens: 1 } } })];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      for (const piece of String(block.text).split("|")) events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }));
      for (const citation of (block.citations ?? []) as Block[]) events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "citations_delta", citation } }));
    } else if (block.type === "thinking") {
      events.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }));
      events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }));
      events.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }));
    } else {
      events.push(sse("content_block_start", { type: "content_block_start", index, content_block: block }));
    }
    events.push(sse("content_block_stop", { type: "content_block_stop", index }));
  });
  events.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output, ...(iterations ? { iterations } : {}) } }));
  events.push(sse("message_stop", { type: "message_stop" }));
  return events;
}

const errorBody = (type: string, message = `raw body ${sentinelKey}`) => ({ type: "error", error: { type, message } });

function fakeApi(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    const reply = replies.shift();
    assert(reply, "unexpected request");
    if (reply.error) throw new TypeError("fetch failed");
    if (reply.sse) return new Response(reply.sse.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (reply.hang) {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of reply.hang!) controller.enqueue(new TextEncoder().encode(chunk));
          signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  return { calls, fetch, replies };
}

// ---- Isolated runtime home and inoai Session ----

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-anthropic-api-runtime-"));
  const home = await bootstrapRuntimeHome(deployment);
  let database = openDatabase(home);
  let store = createSqliteOperationalStore(database);
  t.after(async () => {
    if (database.isOpen) await store.close();
    await rm(deployment, { recursive: true, force: true });
  });
  const owner = await store.bootstrapOwner({ discordGuildId: "guild", discordOwnerUserId: "owner" } as Configuration, "owner:test");
  let thread = 0;
  const resolver = (provider = "anthropic-api") => async (agentSessionId: string) => (await store.findSessionByAgentSession(provider, agentSessionId))?.id;
  const ctx = {
    get database() { return database; },
    get store() { return store; },
    // Creates a runtime against the current store with a fake API.
    runtime(replies: Reply[], options: Partial<AnthropicApiRuntimeOptions> = {}) {
      const api = fakeApi(replies);
      const client = createAnthropicApiClient({ apiKey: sentinelKey, fetch: api.fetch });
      const runtime = new AnthropicApiRuntime({ client, history: store, resolveSessionId: resolver(), model, effort: "high", modelMaxTokens: 128_000, ...options });
      return { runtime, api };
    },
    // Starts an Agent Session and binds it to a new inoai Session, as the conversation worker does.
    async start(runtime: AnthropicApiRuntime, instructions = "You are inoai.") {
      const agentSessionId = await runtime.createSession(deployment, instructions);
      thread += 1;
      const session = await store.createSession({
        user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
        conversation_id: `thread-${thread}`, initiating_external_message_id: `starter-${thread}`, agent_provider: "anthropic-api",
        agent_session_id: agentSessionId, project_path: deployment,
      }, "session:test");
      return { agentSessionId, sessionId: session.id };
    },
    async reopen() {
      await store.close();
      database = openDatabase(home);
      store = createSqliteOperationalStore(database);
    },
    count(table: string) {
      return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    },
    deployment,
  };
  return ctx;
}

async function collect(runtime: AnthropicApiRuntime, agentSessionId: string, prompt: string): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.runTurn(agentSessionId, prompt)) events.push(event);
  return events;
}

async function failsWith(promise: Promise<unknown>, kind: RuntimeFailureKind, replaySafe = false): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert(error instanceof RuntimeFailure, `expected RuntimeFailure, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.equal(error.replaySafe, replaySafe);
    assert.equal(error.message, kind);
    return true;
  });
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const thinking = { type: "thinking", thinking: "reasoning", signature: "sig-1" };

// ---- Tests ----

test("a first and a resumed Turn send the frozen prompt, full history, pinned tools, effort, max_tokens, and cache control", async (t) => {
  const ctx = await fixture(t);
  const { runtime, api } = ctx.runtime([
    { sse: streamed([thinking, { type: "text", text: "Hello| world" }], "end_turn") },
    { sse: streamed([{ type: "text", text: "Second" }], "end_turn") },
  ]);
  const { agentSessionId, sessionId } = await ctx.start(runtime);
  assert.equal(ctx.count("agent_history_sessions"), 0, "createSession writes nothing");

  const first = await collect(runtime, agentSessionId, "first prompt");
  assert.deepEqual(first, [
    { type: "progress", text: "Hello" },
    { type: "progress", text: " world" },
    { type: "usage", inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 },
    { type: "answer", text: "Hello world" },
  ]);

  await runtime.resumeSession(agentSessionId, ctx.deployment, "You are inoai.");
  const second = await collect(runtime, agentSessionId, "second prompt");
  assert.deepEqual(second.map((event) => event.type), ["progress", "usage", "answer"]);

  assert.equal(api.calls.length, 2);
  for (const { body } of api.calls) {
    assert.equal(body.model, model);
    assert.equal(body.max_tokens, 64_000);
    assert.equal(body.system, "You are inoai.");
    assert.deepEqual(body.tools, anthropicApiTools);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.equal(body.stream, true);
  }
  assert.deepEqual(anthropicApiTools, [
    { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"], max_uses: 5 },
    { type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"], max_uses: 5, max_content_tokens: 20_000 },
  ]);
  assert.deepEqual(api.calls[0]!.body.messages, [user("first prompt")]);
  // The thinking block is replayed unchanged, with its signature.
  assert.deepEqual(api.calls[1]!.body.messages, [
    user("first prompt"),
    { role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "sig-1" }, { type: "text", text: "Hello world" }] },
    user("second prompt"),
  ]);
  const rows = await ctx.store.listHistory(sessionId, agentSessionId);
  assert.deepEqual(rows.map((row) => [row.ordinal, row.role, row.model]), [[0, "user", null], [1, "assistant", model], [2, "user", null], [3, "assistant", model]]);
});

test("max_tokens is the model maximum when below 64,000, and effort is omitted when unset", async (t) => {
  const ctx = await fixture(t);
  const { runtime, api } = ctx.runtime([{ sse: streamed([{ type: "text", text: "ok" }], "end_turn") }], { modelMaxTokens: 32_000, effort: undefined });
  const { agentSessionId } = await ctx.start(runtime);
  await collect(runtime, agentSessionId, "hi");
  assert.equal(api.calls[0]!.body.max_tokens, 32_000);
  assert.equal("output_config" in api.calls[0]!.body, false);
});

test("a changed agent.md keeps the frozen system prompt and adds one system message", async (t) => {
  const ctx = await fixture(t);
  const ok = (text: string) => ({ sse: streamed([{ type: "text", text }], "end_turn") });
  const { runtime, api } = ctx.runtime([ok("one"), ok("two"), ok("three")]);
  const { agentSessionId, sessionId } = await ctx.start(runtime, "Old instructions.");
  await collect(runtime, agentSessionId, "p1");
  await runtime.resumeSession(agentSessionId, ctx.deployment, "New instructions.");
  await collect(runtime, agentSessionId, "p2");
  await runtime.resumeSession(agentSessionId, ctx.deployment, "New instructions.");
  await collect(runtime, agentSessionId, "p3");

  for (const { body } of api.calls) assert.equal(body.system, "Old instructions.");
  const system = { role: "system", content: [{ type: "text", text: "New instructions." }] };
  assert.deepEqual(api.calls[1]!.body.messages, [user("p1"), { role: "assistant", content: [{ type: "text", text: "one" }] }, user("p2"), system]);
  // The system message is now history, so an unchanged later Turn adds none.
  assert.deepEqual(api.calls[2]!.body.messages, [user("p1"), { role: "assistant", content: [{ type: "text", text: "one" }] }, user("p2"), system,
    { role: "assistant", content: [{ type: "text", text: "two" }] }, user("p3")]);
  const rows = await ctx.store.listHistory(sessionId, agentSessionId);
  assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "user", "system", "assistant", "user", "assistant"]);
});

test("pause_turn continues without a new user message, usage sums across continuations, and the cap holds", async (t) => {
  const ctx = await fixture(t);
  const searching = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } };
  const { runtime, api } = ctx.runtime([
    { sse: streamed([searching, { type: "text", text: "Part a. " }], "pause_turn", { input: 10, created: 1, read: 0, output: 4 }) },
    { sse: streamed([{ type: "text", text: "Part b." }], "end_turn", { input: 20, created: 0, read: 11, output: 6 }) },
  ]);
  const { agentSessionId, sessionId } = await ctx.start(runtime);
  const events = await collect(runtime, agentSessionId, "search");
  const total: Usage = {};
  for (const event of events) if (event.type === "usage") addUsage(total, event);
  assert.deepEqual(total, { inputTokens: 31, cachedInputTokens: 11, outputTokens: 10 });
  assert.deepEqual(events.at(-1), { type: "answer", text: "Part a. Part b." });
  assert.equal(events.filter((event) => event.type === "answer").length, 1);
  assert.deepEqual(api.calls[1]!.body.messages, [user("search"), { role: "assistant", content: [searching, { type: "text", text: "Part a. " }] }]);
  assert.deepEqual((await ctx.store.listHistory(sessionId, agentSessionId)).map((row) => row.role), ["user", "assistant", "assistant"]);

  // Five continuations are allowed; a sixth pause fails the Turn and writes nothing.
  const paused = () => ({ sse: streamed([{ type: "text", text: "." }], "pause_turn") });
  const capped = ctx.runtime([paused(), paused(), paused(), paused(), paused(), paused(), paused()]);
  const second = await ctx.start(capped.runtime);
  await failsWith(collect(capped.runtime, second.agentSessionId, "loop"), "uncertain");
  assert.equal(capped.api.calls.length, 6);
  assert.deepEqual(await ctx.store.listHistory(second.sessionId, second.agentSessionId), []);
});

test("errors map to fixed failure kinds, and failed Turns write no history", async (t) => {
  const ctx = await fixture(t);
  const started = [streamed([{ type: "text", text: "partial" }], "end_turn")[0]!, streamed([{ type: "text", text: "partial" }], "end_turn")[1]!];
  const cases: Array<[string, Reply[], RuntimeFailureKind, boolean?, Partial<AnthropicApiRuntimeOptions>?]> = [
    ["401", [{ status: 401, body: errorBody("authentication_error") }], "authentication"],
    ["403", [{ status: 403, body: errorBody("permission_error") }], "authentication"],
    ["429", [{ status: 429, body: errorBody("rate_limit_error") }], "usage"],
    ["billing", [{ status: 400, body: errorBody("billing_error") }], "usage"],
    ["529 before output", [{ status: 529, body: errorBody("overloaded_error") }], "pre_start", true],
    ["500 before output", [{ status: 500, body: errorBody("api_error") }], "pre_start", true],
    ["connection error", [{ error: true }], "pre_start", true],
    ["529 in a continuation", [{ sse: streamed([{ type: "text", text: "a" }], "pause_turn") }, { status: 529, body: errorBody("overloaded_error") }], "uncertain"],
    ["mid-stream error event", [{ sse: [...started, sse("error", errorBody("overloaded_error"))] }], "uncertain"],
    ["error event before any output", [{ sse: [sse("error", errorBody("overloaded_error"))] }], "uncertain"],
    ["stream cut short", [{ sse: started }], "uncertain"],
    ["context window stop reason", [{ sse: streamed([{ type: "text", text: "a" }], "model_context_window_exceeded") }], "context_exhausted"],
    ["too-long prompt 400", [{ status: 400, body: errorBody("invalid_request_error", "prompt is too long: 1000001 tokens > 1000000 maximum") }], "context_exhausted"],
    ["other 400", [{ status: 400, body: errorBody("invalid_request_error") }], "uncertain"],
    ["idle timeout", [{ hang: started }], "timed_out", false, { idleTimeoutMs: 50 }],
    ["idle before any event", [{ hang: [] }], "timed_out", false, { idleTimeoutMs: 50 }],
  ];
  for (const [name, replies, kind, replaySafe, options] of cases) {
    const { runtime, api } = ctx.runtime(replies, options);
    const { agentSessionId, sessionId } = await ctx.start(runtime);
    await t.test(name, async () => {
      await failsWith(collect(runtime, agentSessionId, "prompt"), kind, replaySafe ?? false);
      assert.equal(api.replies.length, 0, "no SDK retries");
      assert.deepEqual(await ctx.store.listHistory(sessionId, agentSessionId), []);
    });
  }
  assert.equal(ctx.count("agent_history"), 0);
  const notice = runtimeFailureNotice("context_exhausted", { displayName: "Anthropic API", loginHint: "ANTHROPIC_API_KEY" });
  assert.match(notice, /\/inoai reset/);
});

test("an unresolvable Session fails closed as session_missing without a request", async (t) => {
  const ctx = await fixture(t);
  const { runtime, api } = ctx.runtime([], { resolveSessionId: async () => undefined });
  const agentSessionId = await runtime.createSession(ctx.deployment, "You are inoai.");
  await failsWith(collect(runtime, agentSessionId, "hi"), "session_missing");
  assert.equal(api.calls.length, 0);
});

test("a cancelled Turn aborts the request and writes nothing", async (t) => {
  const ctx = await fixture(t);
  const { runtime } = ctx.runtime([{ hang: streamed([{ type: "text", text: "partial" }], "end_turn").slice(0, 3) }]);
  const { agentSessionId, sessionId } = await ctx.start(runtime);
  const events: RuntimeEvent[] = [];
  await failsWith((async () => {
    for await (const event of runtime.runTurn(agentSessionId, "long")) {
      events.push(event);
      if (event.type === "progress") await runtime.cancel(agentSessionId);
    }
  })(), "cancelled");
  assert.deepEqual(events, [{ type: "progress", text: "partial" }]);
  assert.deepEqual(await ctx.store.listHistory(sessionId, agentSessionId), []);
});

test("a new runtime instance replays history from the same database after a restart", async (t) => {
  const ctx = await fixture(t);
  const first = ctx.runtime([{ sse: streamed([thinking, { type: "text", text: "Remembered." }], "end_turn") }]);
  const { agentSessionId } = await ctx.start(first.runtime);
  await collect(first.runtime, agentSessionId, "remember this");
  await first.runtime.close();

  await ctx.reopen();
  const second = ctx.runtime([{ sse: streamed([{ type: "text", text: "Yes." }], "end_turn") }]);
  await second.runtime.resumeSession(agentSessionId, ctx.deployment, "You are inoai.");
  assert.deepEqual(await collect(second.runtime, agentSessionId, "what was it?").then((events) => events.at(-1)), { type: "answer", text: "Yes." });
  assert.equal(second.api.calls[0]!.body.system, "You are inoai.");
  assert.deepEqual(second.api.calls[0]!.body.messages, [
    user("remember this"),
    { role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "sig-1" }, { type: "text", text: "Remembered." }] },
    user("what was it?"),
  ]);
});

test("the API key appears in no event, error, or stored row", async (t) => {
  const ctx = await fixture(t);
  const { runtime, api } = ctx.runtime([
    { sse: streamed([{ type: "text", text: "fine" }], "end_turn") },
    { status: 401, body: errorBody("authentication_error") },
    { sse: [streamed([], "end_turn")[0]!, sse("error", errorBody("api_error"))] },
  ]);
  const { agentSessionId } = await ctx.start(runtime);
  const seen: unknown[] = [];
  seen.push(await collect(runtime, agentSessionId, "hello"));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await collect(runtime, agentSessionId, "again");
    } catch (error) {
      assert(error instanceof RuntimeFailure);
      seen.push({ kind: error.kind, message: error.message, stack: error.stack, cause: String(error.cause) });
    }
  }
  assert.equal(api.calls[0]!.headers.get("authorization"), `Bearer ${sentinelKey}`, "the fake API saw the key");
  const tables = (ctx.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name);
  for (const table of tables) seen.push(ctx.database.prepare(`SELECT * FROM "${table}"`).all());
  const text = JSON.stringify(seen);
  assert.equal(text.includes(sentinelKey), false);
  assert.equal(text.includes("raw body"), false);
});

// ---- Fallbacks, refusals, and sources (T-0004) ----

const fallback = { type: "fallback", from: { model }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "cyber" } };

test("fallbacks are sent only for models that support them", async (t) => {
  const ctx = await fixture(t);
  for (const [name, supported] of [["claude-fable-5-2", true], ["claude-fable-5-1", true], ["claude-opus-5-5", true], ["claude-opus-5", true],
    ["claude-sonnet-5-5", true], ["claude-haiku-5-5", false], ["claude-sonnet-5", false], ["claude-opus-4-8", false]] as const) {
    const { runtime, api } = ctx.runtime([{ sse: streamed([{ type: "text", text: "ok" }], "end_turn") }], { model: name });
    const { agentSessionId } = await ctx.start(runtime);
    await collect(runtime, agentSessionId, "hi");
    const { body, headers } = api.calls[0]!;
    assert.equal(body.fallbacks, supported ? "default" : undefined, name);
    assert.equal("betas" in body, false, "betas travel as a header");
    assert.equal(headers.get("anthropic-beta"), supported ? "server-side-fallback-2026-07-01" : null, name);
  }
});

test("replay leaves out the required blocks before the final fallback block, across pause_turn rows, and keeps the rest", async (t) => {
  const ctx = await fixture(t);
  const redacted = { type: "redacted_thinking", data: "opaque" };
  const unmatched = { type: "server_tool_use", id: "srvtoolu_a", name: "web_search", input: { query: "a" } };
  const matched = { type: "server_tool_use", id: "srvtoolu_b", name: "web_search", input: { query: "b" } };
  const result = { type: "web_search_tool_result", tool_use_id: "srvtoolu_b", content: [] };
  const localTool = { type: "tool_use", id: "toolu_1", name: "local", input: {} };
  const after = { type: "thinking", thinking: "after", signature: "sig-2" };
  const lateTool = { type: "server_tool_use", id: "srvtoolu_c", name: "web_search", input: { query: "c" } };
  const first = [thinking, redacted, unmatched, { type: "text", text: "a" }];
  const second = [matched, result, localTool, { type: "text", text: "b" }, { ...thinking, signature: "sig-3" }, fallback, after, lateTool, { type: "text", text: "c" }];
  const { runtime, api } = ctx.runtime([
    { sse: streamed(first, "pause_turn") },
    { sse: streamed(second, "end_turn") },
    { sse: streamed([{ type: "text", text: "next" }], "end_turn") },
  ]);
  const { agentSessionId, sessionId } = await ctx.start(runtime);
  assert.deepEqual((await collect(runtime, agentSessionId, "go")).at(-1), { type: "answer", text: "abc" });
  // Before the fallback arrives, the continuation replays the first row unchanged.
  assert.deepEqual(api.calls[1]!.body.messages, [user("go"), { role: "assistant", content: first }]);
  // Rows stay raw.
  const rows = await ctx.store.listHistory(sessionId, agentSessionId);
  assert.deepEqual(rows.slice(1).map((row) => JSON.parse(row.contentJson)), [first, second]);

  await runtime.resumeSession(agentSessionId, ctx.deployment, "You are inoai.");
  await collect(runtime, agentSessionId, "again");
  assert.deepEqual(api.calls[2]!.body.messages, [
    user("go"),
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [matched, result, { type: "text", text: "b" }, fallback, after, lateTool, { type: "text", text: "c" }] },
    user("again"),
  ]);
});

test("refusal and max_tokens Turns write no history and answer with their fixed notices", async (t) => {
  const ctx = await fixture(t);
  const cases: Array<[string, Reply[], string]> = [
    ["refusal", [{ sse: streamed([{ type: "text", text: "partial" }], "refusal") }], anthropicApiRefusalNotice],
    ["refusal before output", [{ sse: streamed([], "refusal") }], anthropicApiRefusalNotice],
    ["refusal in a continuation", [{ sse: streamed([{ type: "text", text: "a" }], "pause_turn") }, { sse: streamed([fallback, { type: "text", text: "b" }], "refusal") }], anthropicApiRefusalNotice],
    ["max_tokens", [{ sse: streamed([{ type: "text", text: "long" }], "max_tokens") }], anthropicApiMaxTokensNotice],
  ];
  for (const [name, replies, notice] of cases) {
    const { runtime, api } = ctx.runtime([...replies, { sse: streamed([{ type: "text", text: "fresh" }], "end_turn") }]);
    const { agentSessionId, sessionId } = await ctx.start(runtime);
    await t.test(name, async () => {
      const events = await collect(runtime, agentSessionId, "prompt");
      assert.deepEqual(events.filter((event) => event.type === "answer"), [{ type: "answer", text: notice }]);
      assert(events.some((event) => event.type === "usage"), "usage is still reported");
      assert.deepEqual(await ctx.store.listHistory(sessionId, agentSessionId), []);
      // The next Turn replays nothing from the refused or cut-off Turn.
      await runtime.resumeSession(agentSessionId, ctx.deployment, "You are inoai.");
      await collect(runtime, agentSessionId, "next");
      assert.deepEqual(api.calls.at(-1)!.body.messages, [user("next")]);
    });
  }
  assert.notEqual(anthropicApiRefusalNotice, anthropicApiMaxTokensNotice);
});

test("usage sums the fallback chain's per-attempt iterations", async (t) => {
  const ctx = await fixture(t);
  const iterations = [
    { type: "message", model, input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens: 3, cache_creation: null },
    { type: "fallback_message", model: "claude-opus-5", input_tokens: 20, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7, cache_creation: null },
  ];
  const { runtime } = ctx.runtime([{ sse: streamed([fallback, { type: "text", text: "ok" }], "end_turn", { input: 20, created: 2, read: 5, output: 7 }, iterations) }]);
  const { agentSessionId } = await ctx.start(runtime);
  const events = await collect(runtime, agentSessionId, "hi");
  assert.deepEqual(events.filter((event) => event.type === "usage"), [{ type: "usage", inputTokens: 32, cachedInputTokens: 9, outputTokens: 10 }]);
});

test("cited web search results add a de-duplicated, capped Sources list; no citations add none", async (t) => {
  const ctx = await fixture(t);
  const cite = (n: number, title: string | null = `Title ${n}`) => ({ type: "web_search_result_location", url: `https://example.com/${n}`, title, cited_text: "x", encrypted_index: "e" });
  const document = { type: "char_location", cited_text: "x", document_index: 0, document_title: "Doc", start_char_index: 0, end_char_index: 1, file_id: null };
  const { runtime } = ctx.runtime([
    { sse: streamed([
      { type: "text", text: "One.", citations: [cite(1), cite(2, null)] },
      { type: "text", text: " Two.", citations: [cite(1), document, cite(3, "Multi\nline  title")] },
      { type: "text", text: " Three.", citations: [cite(4), cite(5), cite(6), cite(7)] },
    ], "end_turn") },
    { sse: streamed([{ type: "text", text: "Plain." }], "end_turn") },
  ]);
  const { agentSessionId } = await ctx.start(runtime);
  const cited = await collect(runtime, agentSessionId, "search");
  assert.deepEqual(cited.at(-1), { type: "answer", text: [
    "One. Two. Three.", "", "Sources:",
    "- Title 1: https://example.com/1", "- https://example.com/2", "- Multi line title: https://example.com/3",
    "- Title 4: https://example.com/4", "- Title 5: https://example.com/5",
  ].join("\n") });
  await runtime.resumeSession(agentSessionId, ctx.deployment, "You are inoai.");
  assert.deepEqual((await collect(runtime, agentSessionId, "plain")).at(-1), { type: "answer", text: "Plain." });
});

// ---- Memory Review ----

const fencedJson = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function reviewSnapshot(): MemoryReviewSnapshot {
  return {
    cursor: 0,
    messages: [{ id: 11, session_id: 1, transport: "discord", workspace_id: "guild", external_message_id: "m11",
      external_author_id: "owner", user_id: 9, direction: "user", body: "Please remember that I prefer tabs.", reply_to_external_message_id: null,
      in_reply_to_message_id: null, state: "completed", failure_detail: null, started_at: null, runtime_started_at: null,
      completed_at: 11, provisional_id: null, delivery_state: null, created_at: 11, updated_at: 11, deleted_at: null,
      created_by: "test", updated_by: "test", deleted_by: null }],
    ownerUserIds: [9], memories: [], recaps: [],
  };
}

test("review sends one streamed, tool-free request with no history and the review instructions, and passes through reviewSessionWithStore", async (t) => {
  const ctx = await fixture(t);
  const final = { recap: "prefers tabs", actions: [{ op: "add", body: "The owner prefers tabs.", source_message_ids: [11], source_recap_ids: [] }] };
  const { runtime, api } = ctx.runtime([
    { sse: streamed([{ type: "text", text: fencedJson({ notes: "window notes" }) }], "end_turn") },
    { sse: streamed([thinking, { type: "text", text: fencedJson(final) }], "end_turn") },
  ], { modelMaxTokens: 128_000 });
  const commits: MemoryReviewCommit[] = [];
  const store = {
    async readMemoryReview() { return reviewSnapshot(); },
    async commitMemoryReview(input: MemoryReviewCommit) { commits.push(input); return { state: "completed" as const, reviewId: 12 }; },
  };
  const result = await reviewSessionWithStore(store, runtime, 1, { maxChars: 20_000 });
  assert.deepEqual(result, { state: "completed", reviewId: 12, throughMessageId: 11, added: 1, updated: 0, deleted: 0, ignored: [], proposalIds: [], changes: [{ op: "add", body: "The owner prefers tabs." }] });
  assert.equal(commits.length, 1);
  assert.equal(api.calls.length, 2);
  for (const { body, headers } of api.calls) {
    assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "stream", "system"]);
    assert.equal(body.stream, true);
    assert.equal(body.model, model);
    assert.equal(body.max_tokens, 16_000);
    assert.equal(body.system, reviewInstructions);
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content.length, 1);
    assert.match(messages[0]!.content[0]!.text, /prefer tabs/);
    assert.equal(headers.get("anthropic-beta"), null);
  }
  assert.equal(ctx.count("agent_history_sessions"), 0);
  assert.equal(ctx.count("agent_history"), 0);
});

test("review max_tokens stays at the model maximum when below 16,000", async (t) => {
  const ctx = await fixture(t);
  const { runtime, api } = ctx.runtime([{ sse: streamed([{ type: "text", text: "a|b" }], "end_turn") }], { modelMaxTokens: 8_192 });
  assert.equal(await runtime.review("p"), "ab");
  assert.equal(api.calls[0]!.body.max_tokens, 8_192);
});

test("review failures are fixed, replay-safe failure kinds and write no history", async (t) => {
  const ctx = await fixture(t);
  const started = streamed([{ type: "text", text: "partial" }], "end_turn").slice(0, 3);
  const toolUse = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } };
  const cases: Array<[string, Reply[], RuntimeFailureKind, Partial<AnthropicApiRuntimeOptions>?]> = [
    ["authentication", [{ status: 401, body: errorBody("authentication_error") }], "authentication"],
    ["rate limit", [{ status: 429, body: errorBody("rate_limit_error") }], "usage"],
    ["server error", [{ status: 500, body: errorBody("api_error") }], "pre_start"],
    ["network", [{ error: true }], "pre_start"],
    ["refusal", [{ sse: streamed([{ type: "text", text: "no" }], "refusal") }], "uncertain"],
    ["max_tokens", [{ sse: streamed([{ type: "text", text: "long" }], "max_tokens") }], "uncertain"],
    ["context window", [{ sse: streamed([{ type: "text", text: "x" }], "model_context_window_exceeded") }], "context_exhausted"],
    ["tool block", [{ sse: streamed([toolUse, { type: "text", text: "x" }], "end_turn") }], "uncertain"],
    ["idle timeout", [{ hang: started }], "timed_out", { reviewIdleTimeoutMs: 50 }],
    ["idle before any event", [{ hang: [] }], "timed_out", { reviewIdleTimeoutMs: 50 }],
  ];
  for (const [name, replies, kind, options] of cases) {
    await t.test(name, async () => {
      const { runtime } = ctx.runtime(replies, options);
      await failsWith(runtime.review("review"), kind, true);
    });
  }
  assert.equal(ctx.count("agent_history"), 0);
});

test("review honours its abort signal, close, and a pre-aborted signal", async (t) => {
  const ctx = await fixture(t);
  const started = streamed([{ type: "text", text: "partial" }], "end_turn").slice(0, 3);
  const aborting = ctx.runtime([{ hang: started }]);
  const controller = new AbortController();
  const pending = aborting.runtime.review("p", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await failsWith(pending, "cancelled", true);

  const closing = ctx.runtime([{ hang: started }]);
  const closed = closing.runtime.review("p");
  setTimeout(() => void closing.runtime.close(), 20);
  await failsWith(closed, "cancelled", true);
  await failsWith(closing.runtime.review("p"), "pre_start", true);

  const preAborted = ctx.runtime([]);
  await failsWith(preAborted.runtime.review("p", { signal: AbortSignal.abort() }), "cancelled", true);
  assert.equal(preAborted.api.calls.length, 0);
  assert.equal(ctx.count("agent_history"), 0);
});
