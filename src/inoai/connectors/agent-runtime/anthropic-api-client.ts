import Anthropic, { APIConnectionError, APIError, AuthenticationError, NotFoundError, PermissionDeniedError, type ClientOptions } from "@anthropic-ai/sdk";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";

import type { AnthropicApiEffort } from "../../agent-instance/config.js";

/** The only host the anthropic-api runtime talks to. `ANTHROPIC_BASE_URL` in `process.env` never changes it. */
export const anthropicApiBaseUrl = "https://api.anthropic.com";
/** Upper bound for one SDK request. The runtime adds its own idle timeouts for streamed Turns. */
export const anthropicApiRequestTimeoutMs = 600_000;
export const anthropicApiModelCheckTimeoutMs = 30_000;

export type AnthropicApiClientOptions = {
  apiKey: string;
  /** Test seam: replaces the global `fetch`. */
  fetch?: ClientOptions["fetch"];
};

/**
 * Builds the pinned SDK client. The explicit key stops the SDK reading `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a
 * profile from the environment. The explicit base URL, log level, and OpenTelemetry option stop it reading
 * `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG`, and `ANTHROPIC_OPEN_TELEMETRY*`. `runRuntimeTurn` owns retries, so the SDK makes none.
 * Error messages never include the key.
 */
export function createAnthropicApiClient(options: AnthropicApiClientOptions): Anthropic {
  if (!options.apiKey.trim()) throw new Error("ANTHROPIC_API_KEY is required for the anthropic-api provider");
  // The SDK always adds these headers from process.env and has no option to turn that off.
  if (process.env.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
    throw new Error("ANTHROPIC_CUSTOM_HEADERS is set in the process environment; unset it to use the anthropic-api provider");
  }
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: anthropicApiBaseUrl,
    logLevel: "off",
    openTelemetry: { traces: false, propagation: false },
    maxRetries: 0,
    timeout: anthropicApiRequestTimeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type AnthropicApiModelLimits = {
  /** The model's maximum `max_tokens`. */
  maxTokens: number;
  /** The model's input context window in tokens. */
  maxInputTokens: number;
};

/**
 * Startup check: proves the key and model work without spending tokens, and that the model supports adaptive thinking,
 * web search, and the configured effort. Failures use fixed messages that never quote the key, the model setting, or a
 * response body.
 */
export async function checkAnthropicApiModel(client: Anthropic, model: string, effort?: AnthropicApiEffort): Promise<AnthropicApiModelLimits> {
  let info: ModelInfo;
  try {
    info = await client.models.retrieve(model, null, { timeout: anthropicApiModelCheckTimeoutMs });
  } catch (error) {
    throw new Error(modelCheckFailure(error));
  }
  const capabilities = info.capabilities;
  if (!capabilities) throw new Error("Anthropic API model check failed: the model reported no capabilities");
  if (capabilities.thinking?.types?.adaptive?.supported !== true) {
    throw new Error("Anthropic API model check failed: ANTHROPIC_API_MODEL does not support adaptive thinking");
  }
  if (capabilities.server_tools?.web_search?.supported !== true) {
    throw new Error("Anthropic API model check failed: ANTHROPIC_API_MODEL does not support web search");
  }
  if (effort && (capabilities.effort?.supported !== true || capabilities.effort[effort]?.supported !== true)) {
    throw new Error(`Anthropic API model check failed: ANTHROPIC_API_MODEL does not support ANTHROPIC_API_EFFORT=${effort}`);
  }
  if (!isPositiveInteger(info.max_tokens) || !isPositiveInteger(info.max_input_tokens)) {
    throw new Error("Anthropic API model check failed: the model reported no token limits");
  }
  return { maxTokens: info.max_tokens, maxInputTokens: info.max_input_tokens };
}

function modelCheckFailure(error: unknown): string {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return "Anthropic API model check failed: ANTHROPIC_API_KEY was rejected";
  }
  if (error instanceof NotFoundError) return "Anthropic API model check failed: ANTHROPIC_API_MODEL is not a known model";
  if (error instanceof APIConnectionError) return "Anthropic API model check failed: the API could not be reached";
  if (error instanceof APIError && typeof error.status === "number") return `Anthropic API model check failed: HTTP ${error.status}`;
  return "Anthropic API model check failed";
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
