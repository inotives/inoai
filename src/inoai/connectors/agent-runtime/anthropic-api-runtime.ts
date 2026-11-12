import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaToolUnion, BetaUsage, BetaWebFetchTool20260209,
  BetaWebSearchTool20260209, MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { AnthropicApiEffort } from "../../agent-instance/config.js";
import { RuntimeFailure } from "../../agent-runtime/ports.js";
import type { AgentHistoryEntry, AgentHistoryStore, AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";

/** Resolves an Agent Session ID to its inoai `sessions.id`, or `undefined` when no active Session owns it. */
export type AgentSessionResolver = (agentSessionId: string) => Promise<number | undefined>;

export type AnthropicApiRuntimeOptions = {
  /** The pinned client from `createAnthropicApiClient`. The runtime never sees the key itself. */
  client: Anthropic;
  history: AgentHistoryStore;
  resolveSessionId: AgentSessionResolver;
  model: string;
  effort?: AnthropicApiEffort;
  /** The model's maximum `max_tokens`, from `checkAnthropicApiModel`. */
  modelMaxTokens: number;
  /** A Turn fails as `timed_out` after this long with no stream event. */
  idleTimeoutMs?: number;
};

type SessionState = { projectPath: string; instructions: string };
type ActiveTurn = { controller: AbortController; produced: boolean; cancelled: boolean; timedOut: boolean };

const actor = "anthropic-api";
export const anthropicApiMaxOutputTokens = 64_000;
export const anthropicApiMaxContinuations = 5;

/** The pinned server tools, in a fixed order so the frozen prefix is deterministic. No local tools exist. */
export const anthropicApiTools: BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"], max_uses: 5 } satisfies BetaWebSearchTool20260209,
  { type: "web_fetch_20260209", name: "web_fetch", allowed_callers: ["direct"], max_uses: 5, max_content_tokens: 20_000 } satisfies BetaWebFetchTool20260209,
];

/**
 * Agent Runtime for the Anthropic Messages API. Each Agent Session's history lives in the injected `AgentHistoryStore`
 * and is resent on every Turn. The system prompt and tool list are frozen on the Session's first Turn; a later
 * instruction change is appended as a mid-conversation `role: "system"` message. A Turn's rows are written in one
 * transaction before its answer is yielded; a failed or cancelled Turn writes nothing. Errors use fixed kinds only.
 */
export class AnthropicApiRuntime implements AgentRuntime {
  readonly displayName = "Anthropic API";
  readonly loginHint = "ANTHROPIC_API_KEY";
  readonly authenticationNotice = "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in the runtime home's .env, restart inoai, then send a fresh request.";
  private readonly sessions = new Map<string, SessionState>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly client: Anthropic;
  private readonly history: AgentHistoryStore;
  private readonly resolveSessionId: AgentSessionResolver;
  private readonly model: string;
  private readonly effort?: AnthropicApiEffort;
  private readonly maxTokens: number;
  private readonly idleTimeoutMs: number;
  private closed = false;

  constructor({ client, history, resolveSessionId, model, effort, modelMaxTokens, idleTimeoutMs = 300_000 }: AnthropicApiRuntimeOptions) {
    this.client = client;
    this.history = history;
    this.resolveSessionId = resolveSessionId;
    this.model = model;
    this.effort = effort;
    this.maxTokens = Math.min(modelMaxTokens, anthropicApiMaxOutputTokens);
    this.idleTimeoutMs = idleTimeoutMs;
  }

  health(): { state: "ready" | "stopped" | "error" } { return { state: this.closed ? "stopped" : "ready" }; }

  async close(): Promise<void> {
    this.closed = true;
    for (const turn of this.active.values()) {
      turn.cancelled = true;
      turn.controller.abort();
    }
  }

  // Writes nothing: the Session record is frozen on the first Turn, after the worker has bound this ID.
  async createSession(projectPath: string, instructions: string): Promise<string> {
    const id = randomUUID();
    this.sessions.set(id, { projectPath, instructions });
    return id;
  }

  // A Session with no stored rows is simply empty; it is never `session_missing`.
  async resumeSession(sessionId: string, projectPath: string, instructions: string): Promise<void> {
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    this.sessions.set(sessionId, { projectPath, instructions });
  }

  async *runTurn(sessionId: string, prompt: string): AsyncGenerator<RuntimeEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Agent Session must be started or resumed first");
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    if (this.closed) throw new RuntimeFailure("pre_start", true);
    const turn: ActiveTurn = { controller: new AbortController(), produced: false, cancelled: false, timedOut: false };
    this.active.set(sessionId, turn);
    try {
      const { inoaiSessionId, system, tools, messages, entries } = await this.prepare(sessionId, session.instructions, prompt);
      for (let continuations = 0; ; continuations++) {
        const message = yield* this.request(turn, { model: this.model, max_tokens: this.maxTokens, system, tools, messages,
          thinking: { type: "adaptive" }, ...(this.effort ? { output_config: { effort: this.effort } } : {}), cache_control: { type: "ephemeral" } });
        const usage = usageEvent(message.usage);
        if (usage) yield usage;
        // Thinking and server-tool blocks are kept unchanged so the next request can replay them.
        messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] });
        entries.push({ role: "assistant", model: message.model, contentJson: JSON.stringify(message.content) });
        if (message.stop_reason === "end_turn") break;
        if (message.stop_reason === "model_context_window_exceeded") throw new RuntimeFailure("context_exhausted");
        // The API resumes a paused server-tool loop from the trailing assistant content; no extra user message is sent.
        if (message.stop_reason === "pause_turn" && continuations < anthropicApiMaxContinuations) continue;
        throw new RuntimeFailure("uncertain");
      }
      const answer = entries.filter((entry) => entry.role === "assistant").map((entry) => textOf(entry.contentJson)).join("");
      if (turn.cancelled) throw new RuntimeFailure("cancelled");
      try {
        await this.history.appendHistory(inoaiSessionId, sessionId, entries, actor);
      } catch {
        throw new RuntimeFailure("uncertain");
      }
      yield { type: "answer", text: answer };
    } finally {
      this.active.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.active.get(sessionId);
    if (!turn) return;
    turn.cancelled = true;
    turn.controller.abort();
  }

  // Reads the frozen prefix and stored history, and builds this Turn's new rows. Nothing has been sent yet, so a
  // store failure is a replay-safe pre-start failure.
  private async prepare(agentSessionId: string, instructions: string, prompt: string) {
    let inoaiSessionId: number | undefined;
    try {
      inoaiSessionId = await this.resolveSessionId(agentSessionId);
    } catch {
      throw new RuntimeFailure("pre_start", true);
    }
    if (inoaiSessionId === undefined) throw new RuntimeFailure("session_missing");
    try {
      const frozen = await this.history.readOrCreateHistorySession(inoaiSessionId, agentSessionId,
        { systemJson: JSON.stringify(instructions), toolsJson: JSON.stringify(anthropicApiTools), model: this.model }, actor);
      const rows = await this.history.listHistory(inoaiSessionId, agentSessionId);
      const system = JSON.parse(frozen.systemJson) as string;
      const tools = JSON.parse(frozen.toolsJson) as BetaToolUnion[];
      const messages: BetaMessageParam[] = rows.map((row) => ({ role: row.role, content: JSON.parse(row.contentJson) }) as BetaMessageParam);
      // The instructions the model currently follows: the latest stored system message, or the frozen prompt.
      const latestSystem = rows.filter((row) => row.role === "system").at(-1)?.contentJson ?? JSON.stringify(textContent(system));
      const entries: AgentHistoryEntry[] = [{ role: "user", model: null, contentJson: JSON.stringify(textContent(prompt)) }];
      const current = JSON.stringify(textContent(instructions));
      // A system message must follow a user message, so it comes after this Turn's prompt.
      if (current !== latestSystem) entries.push({ role: "system", model: null, contentJson: current });
      for (const entry of entries) messages.push({ role: entry.role, content: JSON.parse(entry.contentJson) } as BetaMessageParam);
      return { inoaiSessionId, system, tools, messages, entries };
    } catch {
      throw new RuntimeFailure("pre_start", true);
    }
  }

  private async *request(turn: ActiveTurn, params: MessageCreateParamsBase): AsyncGenerator<RuntimeEvent, BetaMessage> {
    if (turn.cancelled) throw new RuntimeFailure("cancelled");
    const idle = setTimeout(() => {
      turn.timedOut = true;
      turn.controller.abort();
    }, this.idleTimeoutMs);
    try {
      const stream = this.client.beta.messages.stream(params, { signal: turn.controller.signal });
      for await (const event of stream) {
        idle.refresh();
        turn.produced = true;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "progress", text: event.delta.text };
      }
      return await stream.finalMessage();
    } catch (error) {
      throw failure(turn, error);
    } finally {
      clearTimeout(idle);
    }
  }
}

// Maps an SDK error to a fixed failure kind. SDK messages and response bodies are never carried forward.
function failure(turn: ActiveTurn, error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (turn.cancelled) return new RuntimeFailure("cancelled");
  if (turn.timedOut) return new RuntimeFailure("timed_out");
  // After any stream output, including in a continuation, the outcome is unknown and never replayed.
  if (turn.produced || !(error instanceof APIError) || error instanceof APIUserAbortError) return new RuntimeFailure("uncertain");
  if (error instanceof APIConnectionError) return new RuntimeFailure("pre_start", true);
  // An SSE `error` event has no HTTP status: the request was accepted, so the outcome is unknown.
  if (error.status === undefined) return new RuntimeFailure("uncertain");
  if (error.status === 401 || error.status === 403) return new RuntimeFailure("authentication");
  if (error.status === 429 || error.type === "billing_error") return new RuntimeFailure("usage");
  if (error.status === 400 && /prompt is too long/i.test(error.apiMessage ?? "")) return new RuntimeFailure("context_exhausted");
  if (error.status >= 500) return new RuntimeFailure("pre_start", true);
  return new RuntimeFailure("uncertain");
}

function textContent(text: string): BetaTextBlockParam[] {
  return [{ type: "text", text }];
}

function textOf(contentJson: string): string {
  const blocks = JSON.parse(contentJson) as Array<{ type?: unknown; text?: unknown }>;
  return blocks.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}

// Input includes cache writes; cache reads are reported apart. No cost is recorded.
function usageEvent(usage: BetaUsage | undefined): RuntimeEvent | undefined {
  if (!usage) return undefined;
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const input = count(usage.input_tokens);
  const values = {
    inputTokens: input === undefined ? undefined : input + (count(usage.cache_creation_input_tokens) ?? 0),
    cachedInputTokens: count(usage.cache_read_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
  const reported = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  return Object.keys(reported).length ? { type: "usage", ...reported } : undefined;
}
