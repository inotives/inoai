import { RuntimeFailure } from "../agent-runtime/ports.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime/ports.js";

export type RuntimeTurnStore = {
  createEvent(input: { session_id: number; message_id: number | null; event_type: string; detail: string }, actor: string): Promise<unknown>;
  getSession(sessionId: number): Promise<{ agent_provider: string } | undefined>;
  rebindAgentSession(sessionId: number, oldAgentSessionId: string, newAgentSessionId: string, actor: string): Promise<unknown>;
};

export type RuntimeTurnOutcome =
  | { state: "completed"; answer: string; attempts: number; replaySafe: false }
  | { state: "failed"; reason: RuntimeFailure["kind"]; notice: string; attempts: number; replaySafe: boolean };

const maxAttempts = 3;
function failureNotice(kind: RuntimeFailure["kind"], { displayName: name, loginHint, authenticationNotice }: Pick<AgentRuntime, "displayName" | "loginHint" | "authenticationNotice">): string {
  switch (kind) {
    case "authentication": return authenticationNotice ?? `${name} sign-in needs attention. Run ${loginHint} locally, then send a fresh request.`;
    case "usage": return `${name} usage is unavailable. Check your account locally, then send a fresh request.`;
    case "pre_start": return `${name} could not start the turn. Please send a fresh request.`;
    case "timed_out": return `${name} timed out; its outcome is uncertain. Please send a fresh request.`;
    case "cancelled": return `${name} turn was cancelled. Please send a fresh request if needed.`;
    case "uncertain": return `${name} turn ended without a confirmed answer. Please send a fresh request.`;
    case "session_missing": return `This thread's ${name} session could not be found. Use /inoai reset to start a new session.`;
  }
}

export { failureNotice as runtimeFailureNotice };

function failureKind(error: unknown): { reason: RuntimeFailure["kind"]; replaySafe: boolean } {
  if (error instanceof RuntimeFailure) return { reason: error.kind, replaySafe: error.replaySafe };
  if (error instanceof Error && error.message.startsWith("Codex request timed out:")) return { reason: "timed_out", replaySafe: false };
  return { reason: "uncertain", replaySafe: false };
}

export type Usage = Omit<Extract<RuntimeEvent, { type: "usage" }>, "type">;
const usageKeys = [["inputTokens", "input"], ["outputTokens", "output"], ["cachedInputTokens", "cached"], ["reasoningTokens", "reasoning"], ["costUsd", "cost_usd"]] as const;

export function addUsage(total: Usage, event: Usage): void {
  for (const [field] of usageKeys) {
    const value = event[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field !== "costUsd" && !Number.isInteger(value))) continue;
    total[field] = (total[field] ?? 0) + value;
  }
}

export async function recordUsage(database: Pick<RuntimeTurnStore, "createEvent" | "getSession">, sessionId: number, messageId: number | null, usage: Usage): Promise<void> {
  const parts = usageKeys.flatMap(([field, key]) => {
    const value = usage[field];
    return value === undefined ? [] : [`${key}=${field === "costUsd" ? Number(value.toFixed(6)) : value}`];
  });
  if (!parts.length) return;
  try {
    const provider = await database.getSession(sessionId).then((session) => session?.agent_provider, () => undefined);
    if (provider) parts.push(`provider=${provider}`);
    await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_usage", detail: parts.join("; ") }, "runtime");
  } catch {
    // Usage recording is best effort and never changes the turn outcome.
  }
}

export async function runRuntimeTurn(
  database: RuntimeTurnStore,
  runtime: AgentRuntime,
  sessionId: number,
  agentSessionId: string,
  prompt: string,
  onProgress: (text: string) => void = () => {},
  messageId: number | null = null,
  shutdown?: AbortSignal,
): Promise<RuntimeTurnOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shutdown?.aborted) return { state: "failed", reason: "cancelled", notice: failureNotice("cancelled", runtime), attempts: attempt - 1, replaySafe: false };
    await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_attempt", detail: `attempt=${attempt}` }, "runtime");
    const usage: Usage = {};
    try {
      let answer: string | undefined;
      for await (const event of runtime.runTurn(agentSessionId, prompt)) {
        if (event.type === "progress") onProgress(event.text);
        else if (event.type === "session") {
          const session = await database.getSession(sessionId);
          if (!session) throw new RuntimeFailure("uncertain");
          await database.rebindAgentSession(sessionId, agentSessionId, event.id, `runtime:${session.agent_provider}`);
        } else if (event.type === "usage") addUsage(usage, event);
        else answer = event.text;
      }
      if (answer === undefined) throw new RuntimeFailure("uncertain");
      await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_completed", detail: `attempt=${attempt}` }, "runtime");
      await recordUsage(database, sessionId, messageId, usage);
      return { state: "completed", answer, attempts: attempt, replaySafe: false };
    } catch (error) {
      const { reason, replaySafe } = failureKind(error);
      await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_failure", detail: `attempt=${attempt}; reason=${reason}; replay_safe=${replaySafe}` }, "runtime");
      await recordUsage(database, sessionId, messageId, usage);
      if (shutdown?.aborted) return { state: "failed", reason: "cancelled", notice: failureNotice("cancelled", runtime), attempts: attempt, replaySafe: false };
      if (replaySafe && (reason === "pre_start" || reason === "timed_out") && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      return { state: "failed", reason, notice: failureNotice(reason, runtime), attempts: attempt, replaySafe };
    }
  }
  throw new Error("Unreachable retry state");
}
