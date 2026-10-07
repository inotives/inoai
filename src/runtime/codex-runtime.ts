import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeFailure, reviewInstructions } from "../application/conversation/runtime-port.js";
import type { AgentRuntime, ReviewOptions, RuntimeEvent } from "../application/conversation/runtime-port.js";
import { CodexAppServer } from "./codex-app-server.js";

type ActiveTurn = { started: Promise<string>; interrupt?: Promise<void>; cancelRequested?: boolean };
type TurnNotice = { method: string; params: { threadId?: string; turnId?: string; turn?: { id?: string; status?: string; error?: { codexErrorInfo?: unknown } }; delta?: string; item?: { type?: string; text?: string } } };

// A review turn may only carry these items; any tool, command, file, or search item fails the review closed.
const reviewItemTypes = new Set(["userMessage", "agentMessage", "reasoning"]);

export class CodexRuntime implements AgentRuntime {
  readonly displayName = "Codex";
  readonly loginHint = "codex login";
  private readonly sessions = new Map<string, string>();
  private readonly active = new Map<string, ActiveTurn>();

  // Owner decision D2: Codex reviews stay off unless enableReview is set, because a Codex review thread still loads
  // the owner's MCP servers (ADR 0010). index.ts never sets it; tests exercise the implementation directly.
  readonly review?: (prompt: string, options?: ReviewOptions) => Promise<string>;

  constructor(private readonly server: CodexAppServer, private readonly idleTimeoutMs = 300_000, private readonly reviewTimeoutMs = 600_000, enableReview = false) {
    if (enableReview) this.review = (prompt, options) => this.runReview(prompt, options);
  }

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

  // One Memory Review in a fresh ephemeral read-only thread with approval policy "never" (the Phase 5 probe
  // settings, ADR 0010). It is never added to the session map, so no chat Turn can use it, and the approval relay
  // still declines any request for it without finding a SQLite Session. The cwd is a disposable folder, not the
  // project, so project instructions never shape a text-only summary. On timeout or abort the review turn is
  // interrupted; the shared app-server is never closed. Prompt and answer are never logged or stored here.
  private async runReview(prompt: string, { signal }: ReviewOptions = {}): Promise<string> {
    if (signal?.aborted) throw new RuntimeFailure("cancelled", true);
    if (this.server.health().state !== "ready") throw new RuntimeFailure("pre_start", true);
    let cwd: string;
    try { cwd = await mkdtemp(join(tmpdir(), "inoai-codex-review-")); } catch { throw new RuntimeFailure("pre_start", true); }
    const notices: TurnNotice[] = [];
    let threadId: string | undefined;
    let turnId: string | undefined;
    let failure: RuntimeFailure | undefined;
    let serverFailed = false;
    let wake: (() => void) | undefined;
    const fail = (kind: RuntimeFailure["kind"]) => { failure ??= new RuntimeFailure(kind, true); wake?.(); };
    const removeNotice = this.server.addNotificationListener((method, params) => {
      const notice = { method, params } as TurnNotice;
      if (!threadId || notice.params?.threadId !== threadId) return;
      notices.push(notice);
      wake?.();
    });
    const removeFailure = this.server.addFailureListener(() => { serverFailed = true; fail("uncertain"); });
    const onAbort = () => fail("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    // A listener never fires for a signal that was already aborted, e.g. during mkdtemp above.
    if (signal?.aborted) onAbort();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (failure) throw failure;
      try {
        const result = await this.server.request("thread/start", {
          cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, developerInstructions: reviewInstructions,
        }) as { thread?: { id?: string } };
        threadId = result?.thread?.id;
      } catch { /* classified below */ }
      if (failure) throw failure;
      if (!threadId) throw new RuntimeFailure("pre_start", true);
      timer = setTimeout(() => fail("timed_out"), this.reviewTimeoutMs);
      try {
        const result = await this.server.request("turn/start", {
          threadId, cwd, input: [{ type: "text", text: prompt }], sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never",
        }) as { turn?: { id?: string } };
        turnId = result?.turn?.id;
      } catch { /* classified below */ }
      if (!turnId) throw failure ?? new RuntimeFailure("uncertain", true);
      let answer = "";
      while (true) {
        while (!failure && notices.length) {
          const { method, params } = notices.shift()!;
          if ((params.turnId ?? params.turn?.id) !== turnId) continue;
          if ((method === "item/started" || method === "item/completed") && !reviewItemTypes.has(params.item?.type ?? "")) {
            fail("uncertain");
          } else if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
            answer = params.item.text;
          } else if (method === "turn/completed") {
            turnId = undefined;
            if (params.turn?.status === "completed" && answer) return answer;
            const code = params.turn?.error?.codexErrorInfo;
            if (code === "unauthorized") throw new RuntimeFailure("authentication", true);
            if (code === "usageLimitExceeded" || code === "rateLimitExceeded" || code === "sessionBudgetExceeded") throw new RuntimeFailure("usage", true);
            throw failure ?? new RuntimeFailure("uncertain", true);
          }
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      removeNotice();
      removeFailure();
      // Best-effort and bounded: the ephemeral thread holds nothing worth waiting for.
      if (turnId && !serverFailed) await this.server.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
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
