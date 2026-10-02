import { RuntimeFailure } from "./agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "./agent-runtime.js";
import { CodexAppServer } from "./codex-app-server.js";

type ActiveTurn = { started: Promise<string>; interrupt?: Promise<void>; cancelRequested?: boolean };
type TurnNotice = { method: string; params: { threadId?: string; turnId?: string; turn?: { id?: string; status?: string; error?: { codexErrorInfo?: unknown } }; delta?: string; item?: { type?: string; text?: string } } };

export class CodexRuntime implements AgentRuntime {
  readonly displayName = "Codex";
  readonly loginHint = "codex login";
  private readonly sessions = new Map<string, string>();
  private readonly active = new Map<string, ActiveTurn>();

  constructor(private readonly server: CodexAppServer, private readonly idleTimeoutMs = 300_000) {}

  health(): { state: "ready" | "stopped" | "error" } { return this.server.health(); }
  close(): Promise<void> { return this.server.close(); }

  async hasActiveTurn(sessionId: string, turnId: string): Promise<boolean> {
    const active = this.active.get(sessionId);
    return !!active && await active.started === turnId;
  }

  async createSession(projectPath: string, instructions: string): Promise<string> {
    const result = await this.server.request("thread/start", { cwd: projectPath, developerInstructions: instructions }) as { thread?: { id?: string } };
    const id = result?.thread?.id;
    if (!id) throw new Error("Codex did not return a thread ID");
    this.sessions.set(id, projectPath);
    return id;
  }

  async resumeSession(sessionId: string, projectPath: string, instructions: string): Promise<void> {
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    const result = await this.server.request("thread/resume", { threadId: sessionId, cwd: projectPath, developerInstructions: instructions }) as { thread?: { id?: string } };
    if (result?.thread?.id !== sessionId) throw new Error("Codex resumed a different thread");
    this.sessions.set(sessionId, projectPath);
  }

  async *runTurn(sessionId: string, prompt: string): AsyncGenerator<RuntimeEvent> {
    const projectPath = this.sessions.get(sessionId);
    if (!projectPath) throw new Error("Agent Session must be started or resumed first");
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    if (this.server.health().state !== "ready") throw new RuntimeFailure("pre_start", true);

    const notices: TurnNotice[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let turnId: string | undefined;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const notify = (method: string, params: unknown) => {
      const notice = { method, params } as TurnNotice;
      if (notice.params?.threadId !== sessionId) return;
      if ((notice.params.turnId ?? notice.params.turn?.id) === turnId) {
        if (method === "turn/completed" && idleTimer) clearTimeout(idleTimer);
        else idleTimer?.refresh();
      }
      notices.push(notice);
      wake?.();
    };
    const fail = (error: Error) => { failure ??= error; wake?.(); };
    const removeNotice = this.server.addNotificationListener(notify);
    const removeFailure = this.server.addFailureListener(fail);
    const started = this.server.request("turn/start", { threadId: sessionId, input: [{ type: "text", text: prompt }], cwd: projectPath })
      .then((result) => {
        const id = (result as { turn?: { id?: string } })?.turn?.id;
        if (!id) throw new Error("Codex did not return a turn ID");
        return id;
      });
    const active: ActiveTurn = { started };
    this.active.set(sessionId, active);
    try {
      turnId = await started;
      idleTimer = setTimeout(() => {
        failure = new RuntimeFailure("timed_out");
        void this.server.close().catch(() => {});
        wake?.();
      }, this.idleTimeoutMs);
      let answer = "";
      let deltas = "";
      while (true) {
        if (failure) throw failure;
        if (notices.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
        if (failure) throw failure;
        while (notices.length) {
          const { method, params } = notices.shift()!;
          if ((params.turnId ?? params.turn?.id) !== turnId) continue;
          if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
            deltas += params.delta;
            yield { type: "progress", text: params.delta };
          } else if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
            answer = params.item.text;
          } else if (method === "turn/completed") {
            settled = true;
            if (params.turn?.status !== "completed") {
              if (params.turn?.status === "interrupted" && active.cancelRequested) throw new RuntimeFailure("cancelled");
              const code = params.turn?.error?.codexErrorInfo;
              if (code === "unauthorized") throw new RuntimeFailure("authentication");
              if (code === "usageLimitExceeded" || code === "rateLimitExceeded" || code === "sessionBudgetExceeded") throw new RuntimeFailure("usage");
              throw new RuntimeFailure("uncertain");
            }
            yield { type: "answer", text: answer || deltas };
            return;
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      let cleanupError: Error | undefined;
      if (!settled && turnId && !failure) {
        try {
          const terminal = () => notices.some(({ method, params }) => method === "turn/completed" && (params.turnId ?? params.turn?.id) === turnId);
          if (!terminal()) await this.interrupt(sessionId, active);
          while (!terminal() && !failure) {
            await new Promise<void>((resolve) => { wake = resolve; });
            wake = undefined;
          }
          settled = terminal();
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error("Codex interruption failed");
        }
      }
      removeNotice();
      removeFailure();
      if (settled) this.active.delete(sessionId);
      if (cleanupError) throw cleanupError;
      if (!settled && failure) throw failure;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.cancelRequested = true;
    await this.interrupt(sessionId, active);
  }

  private async interrupt(sessionId: string, active: ActiveTurn): Promise<void> {
    const turnId = await active.started;
    await (active.interrupt ??= this.server.request("turn/interrupt", { threadId: sessionId, turnId }).then(() => {}));
  }
}
