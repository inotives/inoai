export interface AgentRuntime {
  // Shared user-facing notices name the runtime and its local sign-in command.
  readonly displayName: string;
  readonly loginHint: string;
  createSession(projectPath: string, instructions: string): Promise<string>;
  resumeSession(sessionId: string, projectPath: string, instructions: string): Promise<void>;
  runTurn(sessionId: string, prompt: string): AsyncIterable<RuntimeEvent>;
  cancel(sessionId: string): Promise<void>;
  health(): { state: "ready" | "stopped" | "error" };
  close(): Promise<void>;
}

export type RuntimeEvent =
  | { type: "progress"; text: string }
  | { type: "answer"; text: string };

// "session_missing": the runtime has no conversation for a bound session ID; only an explicit reset recovers.
export type RuntimeFailureKind = "authentication" | "usage" | "pre_start" | "timed_out" | "cancelled" | "uncertain" | "session_missing";

// Only an explicit pre-start/no-side-effects signal permits replay.
export class RuntimeFailure extends Error {
  constructor(readonly kind: RuntimeFailureKind, readonly replaySafe = false) {
    super(kind);
  }
}
