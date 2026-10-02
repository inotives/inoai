import type { DatabaseSync } from "node:sqlite";

import { RuntimeFailure } from "./agent-runtime.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { createEvent } from "./database.js";

export type RuntimeTurnOutcome =
  | { state: "completed"; answer: string; attempts: number; replaySafe: false }
  | { state: "failed"; reason: RuntimeFailure["kind"]; notice: string; attempts: number; replaySafe: boolean };

const maxAttempts = 3;
const notices: Record<RuntimeFailure["kind"], string> = {
  authentication: "Codex sign-in needs attention. Run codex login locally, then send a fresh request.",
  usage: "Codex usage is unavailable. Check your account locally, then send a fresh request.",
  pre_start: "Codex could not start the turn. Please send a fresh request.",
  timed_out: "Codex timed out; its outcome is uncertain. Please send a fresh request.",
  cancelled: "Codex turn was cancelled. Please send a fresh request if needed.",
  uncertain: "Codex turn ended without a confirmed answer. Please send a fresh request.",
};

function failureKind(error: unknown): { reason: RuntimeFailure["kind"]; replaySafe: boolean } {
  if (error instanceof RuntimeFailure) return { reason: error.kind, replaySafe: error.replaySafe };
  if (error instanceof Error && error.message.startsWith("Codex request timed out:")) return { reason: "timed_out", replaySafe: false };
  return { reason: "uncertain", replaySafe: false };
}

export async function runRuntimeTurn(
  database: DatabaseSync,
  runtime: AgentRuntime,
  sessionId: number,
  agentSessionId: string,
  prompt: string,
  onProgress: (text: string) => void = () => {},
  messageId: number | null = null,
  shutdown?: AbortSignal,
): Promise<RuntimeTurnOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shutdown?.aborted) return { state: "failed", reason: "cancelled", notice: notices.cancelled, attempts: attempt - 1, replaySafe: false };
    createEvent(database, { session_id: sessionId, message_id: messageId, event_type: "runtime_attempt", detail: `attempt=${attempt}` }, "runtime");
    try {
      let answer: string | undefined;
      for await (const event of runtime.runTurn(agentSessionId, prompt)) {
        if (event.type === "progress") onProgress(event.text);
        else answer = event.text;
      }
      if (answer === undefined) throw new RuntimeFailure("uncertain");
      createEvent(database, { session_id: sessionId, message_id: messageId, event_type: "runtime_completed", detail: `attempt=${attempt}` }, "runtime");
      return { state: "completed", answer, attempts: attempt, replaySafe: false };
    } catch (error) {
      const { reason, replaySafe } = failureKind(error);
      createEvent(database, { session_id: sessionId, message_id: messageId, event_type: "runtime_failure", detail: `attempt=${attempt}; reason=${reason}; replay_safe=${replaySafe}` }, "runtime");
      if (shutdown?.aborted) return { state: "failed", reason: "cancelled", notice: notices.cancelled, attempts: attempt, replaySafe: false };
      if (replaySafe && (reason === "pre_start" || reason === "timed_out") && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      return { state: "failed", reason, notice: notices[reason], attempts: attempt, replaySafe };
    }
  }
  throw new Error("Unreachable retry state");
}
