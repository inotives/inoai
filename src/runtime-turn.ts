import { RuntimeFailure } from "./agent-runtime.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { OperationalStore } from "./operational-store.js";

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

export async function runRuntimeTurn(
  database: Pick<OperationalStore, "createEvent" | "getSession" | "rebindAgentSession">,
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
    try {
      let answer: string | undefined;
      for await (const event of runtime.runTurn(agentSessionId, prompt)) {
        if (event.type === "progress") onProgress(event.text);
        else if (event.type === "session") {
          // Bound as soon as it is reported, so a crash later in the Turn still leaves the real ID in SQLite.
          const session = await database.getSession(sessionId);
          if (!session) throw new RuntimeFailure("uncertain");
          await database.rebindAgentSession(sessionId, agentSessionId, event.id, `runtime:${session.agent_provider}`);
        } else answer = event.text;
      }
      if (answer === undefined) throw new RuntimeFailure("uncertain");
      await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_completed", detail: `attempt=${attempt}` }, "runtime");
      return { state: "completed", answer, attempts: attempt, replaySafe: false };
    } catch (error) {
      const { reason, replaySafe } = failureKind(error);
      await database.createEvent({ session_id: sessionId, message_id: messageId, event_type: "runtime_failure", detail: `attempt=${attempt}; reason=${reason}; replay_safe=${replaySafe}` }, "runtime");
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
