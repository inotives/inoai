import assert from "node:assert/strict";
import test from "node:test";

import { checkAnthropicApiModel, createAnthropicApiClient } from "../../connectors/agent-runtime/anthropic-api-client.js";

const sentinelKey = "sk-ant-api03-SENTINEL-do-not-print";
const envToken = "env-auth-token-SENTINEL";

type Call = { url: string; headers: Headers };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
}

function modelInfo(overrides: { adaptive?: boolean; webSearch?: boolean; xhigh?: boolean | null; capabilities?: null; maxTokens?: number | null } = {}) {
  const support = (supported: boolean) => ({ supported });
  return {
    type: "model",
    id: "claude-opus-5-5",
    display_name: "Claude Opus 5.5",
    created_at: "2026-01-01T00:00:00Z",
    max_tokens: overrides.maxTokens === undefined ? 128000 : overrides.maxTokens,
    max_input_tokens: 1000000,
    capabilities: overrides.capabilities === null ? null : {
      thinking: { supported: true, types: { adaptive: support(overrides.adaptive ?? true), enabled: support(false), disabled: support(true), between_tools: support(true) } },
      server_tools: { supported: true, web_search: support(overrides.webSearch ?? true), code_execution: support(true) },
      effort: { supported: true, low: support(true), medium: support(true), high: support(true), max: support(true),
        xhigh: overrides.xhigh === null ? null : support(overrides.xhigh ?? true) },
    },
  };
}

const errorBody = (type: string) => ({ type: "error", error: { type, message: `raw body ${sentinelKey}` } });

async function withEnv<T>(values: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("pins the host and the configured key even when ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are set", async () => {
  await withEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9/evil", ANTHROPIC_AUTH_TOKEN: envToken, ANTHROPIC_API_KEY: "env-api-key-SENTINEL" }, async () => {
    const fake = fakeFetch(() => json(200, modelInfo()));
    const client = createAnthropicApiClient({ apiKey: sentinelKey, fetch: fake.fetch });
    assert.deepEqual(await checkAnthropicApiModel(client, "claude-opus-5-5"), { maxTokens: 128000, maxInputTokens: 1000000 });
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(call!.url, "https://api.anthropic.com/v1/models/claude-opus-5-5");
    // SDK 1.8 sends the API key as a bearer credential. It must be the configured key, never the environment's token or key.
    assert.equal(call!.headers.get("authorization"), `Bearer ${sentinelKey}`);
    const headerText = JSON.stringify([...call!.headers.entries()]);
    assert.equal(headerText.includes(envToken), false);
    assert.equal(headerText.includes("env-api-key-SENTINEL"), false);
    assert.equal(call!.headers.has("traceparent"), false);
  });
});

test("refuses ANTHROPIC_CUSTOM_HEADERS and an empty key without quoting values", async () => {
  await withEnv({ ANTHROPIC_CUSTOM_HEADERS: `X-Leak: ${sentinelKey}` }, async () => {
    assert.throws(() => createAnthropicApiClient({ apiKey: sentinelKey }), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /ANTHROPIC_CUSTOM_HEADERS is set in the process environment/);
      assert.equal(error.message.includes(sentinelKey), false);
      return true;
    });
  });
  assert.throws(() => createAnthropicApiClient({ apiKey: "  " }), /ANTHROPIC_API_KEY is required/);
});

test("makes no SDK retries", async () => {
  for (const respond of [() => json(529, errorBody("overloaded_error")), () => json(429, errorBody("rate_limit_error")), () => { throw new TypeError("fetch failed"); }]) {
    const fake = fakeFetch(respond);
    const client = createAnthropicApiClient({ apiKey: sentinelKey, fetch: fake.fetch });
    await assert.rejects(checkAnthropicApiModel(client, "claude-opus-5-5"));
    assert.equal(fake.calls.length, 1);
  }
});

test("startup check fails with fixed text for a rejected key, an unknown model, a missing capability, or an unsupported effort", async () => {
  const cases: Array<[Response, RegExp, ("xhigh" | "max")?]> = [
    [json(401, errorBody("authentication_error")), /^Anthropic API model check failed: ANTHROPIC_API_KEY was rejected$/],
    [json(403, errorBody("permission_error")), /^Anthropic API model check failed: ANTHROPIC_API_KEY was rejected$/],
    [json(404, errorBody("not_found_error")), /^Anthropic API model check failed: ANTHROPIC_API_MODEL is not a known model$/],
    [json(500, errorBody("api_error")), /^Anthropic API model check failed: HTTP 500$/],
    [json(200, modelInfo({ capabilities: null })), /^Anthropic API model check failed: the model reported no capabilities$/],
    [json(200, modelInfo({ adaptive: false })), /^Anthropic API model check failed: ANTHROPIC_API_MODEL does not support adaptive thinking$/],
    [json(200, modelInfo({ webSearch: false })), /^Anthropic API model check failed: ANTHROPIC_API_MODEL does not support web search$/],
    [json(200, modelInfo({ xhigh: false })), /^Anthropic API model check failed: ANTHROPIC_API_MODEL does not support ANTHROPIC_API_EFFORT=xhigh$/, "xhigh"],
    [json(200, modelInfo({ xhigh: null })), /^Anthropic API model check failed: ANTHROPIC_API_MODEL does not support ANTHROPIC_API_EFFORT=xhigh$/, "xhigh"],
    [json(200, modelInfo({ maxTokens: null })), /^Anthropic API model check failed: the model reported no token limits$/],
  ];
  for (const [response, message, effort] of cases) {
    const client = createAnthropicApiClient({ apiKey: sentinelKey, fetch: fakeFetch(() => response).fetch });
    await assert.rejects(checkAnthropicApiModel(client, "claude-opus-5-5", effort), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, message);
      assert.equal(error.message.includes(sentinelKey), false);
      assert.equal(error.message.includes("raw body"), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const unreachable = createAnthropicApiClient({ apiKey: sentinelKey, fetch: fakeFetch(() => { throw new TypeError("fetch failed"); }).fetch });
  await assert.rejects(checkAnthropicApiModel(unreachable, "claude-opus-5-5"),
    (error: unknown) => error instanceof Error && error.message === "Anthropic API model check failed: the API could not be reached");
});

test("startup check accepts a supported effort and returns the limits", async () => {
  const client = createAnthropicApiClient({ apiKey: sentinelKey, fetch: fakeFetch(() => json(200, modelInfo())).fetch });
  assert.deepEqual(await checkAnthropicApiModel(client, "claude-opus-5-5", "max"), { maxTokens: 128000, maxInputTokens: 1000000 });
});
