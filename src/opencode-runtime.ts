import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { RuntimeFailure } from "./agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "./agent-runtime.js";

// OpenCode creates its own session ID on the first Turn (a pre-assigned ID is refused by the free tier), so a new
// Agent Session starts under an inoai key and is rebound to the streamed `ses_` ID. Both keys map to one state.
// "verified": this process saw the OpenCode session exist (a Turn with it succeeded, or the existence check passed).
type SessionState = { projectPath: string; instructions: string; opencodeId?: string; verified: boolean; orphaned: boolean };
type ActiveTurn = { child?: ChildProcess; exited?: Promise<void>; cancelRequested?: boolean };
type StreamEvent = { type?: string; sessionID?: unknown; part?: { text?: unknown; state?: { status?: unknown; error?: unknown } }; error?: { type?: unknown } };
type Attempt = { spawnFailed: boolean; timedOut: boolean; authentication: boolean; usage: boolean; errored: boolean; mismatched: boolean; exitCode: number | null; texts: string[]; denials: number };

// Called at most once per Turn with only the Agent Session ID and a denial count; it never sees tool input.
export type OpenCodePermissionDenialListener = (sessionId: string, count: number) => void;
export type OpenCodeRuntimeOptions = { executable?: string; idleTimeoutMs?: number; onPermissionDenied?: OpenCodePermissionDenialListener };

const newSessionPrefix = "inoai-new:";
// OpenCode session IDs reach argv and the API path, so only this shape is ever used, streamed or resumed.
const openCodeSessionId = /^ses_[A-Za-z0-9]+$/;
const maxCheckBytes = 65_536;
const authenticationErrors = new Set(["provider.auth"]);
const usageErrors = new Set(["provider.rate-limit", "provider.quota"]);
// The fixed text of a headless auto-rejection. stderr echoes the same rejections with raw resources and is never read.
const permissionRejection = "This non-interactive run cannot ask the user for permission";

export class OpenCodeRuntime implements AgentRuntime {
  readonly displayName = "OpenCode";
  readonly loginHint = "opencode auth login";
  // A free-tier refusal also surfaces as provider.auth, so the login hint alone would mislead (see the Phase 5b spike).
  readonly authenticationNotice = "OpenCode could not authenticate with its configured provider, or the free tier refused the request. Check opencode auth login locally, then send a fresh request.";
  private readonly sessions = new Map<string, SessionState>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly executable: string;
  private readonly idleTimeoutMs: number;
  private readonly onPermissionDenied?: OpenCodePermissionDenialListener;
  private closed = false;

  constructor({ executable = "opencode", idleTimeoutMs = 300_000, onPermissionDenied }: OpenCodeRuntimeOptions = {}) {
    this.executable = executable;
    this.idleTimeoutMs = idleTimeoutMs;
    this.onPermissionDenied = onPermissionDenied;
  }

  // Confirms the installed CLI can be spawned before Discord starts. It never reads OpenCode config or credentials.
  static async connect(options: OpenCodeRuntimeOptions = {}): Promise<OpenCodeRuntime> {
    const executable = options.executable ?? "opencode";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("OpenCode CLI is unavailable")); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("OpenCode CLI is unavailable")); });
    });
    return new OpenCodeRuntime(options);
  }

  health(): { state: "ready" | "stopped" | "error" } { return { state: this.closed ? "stopped" : "ready" }; }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.values()].map((active) => this.stop(active, "SIGINT")));
  }

  async createSession(projectPath: string, instructions: string): Promise<string> {
    const id = `${newSessionPrefix}${randomUUID()}`;
    this.sessions.set(id, { projectPath, instructions, verified: false, orphaned: false });
    return id;
  }

  async resumeSession(sessionId: string, projectPath: string, instructions: string): Promise<void> {
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    const known = this.sessions.get(sessionId);
    if (known) {
      known.projectPath = projectPath;
      known.instructions = instructions;
      return;
    }
    // An inoai key from an earlier process never received its OpenCode ID, so its conversation cannot be found.
    // A stored ID that is not an OpenCode ID is treated the same way and never reaches the CLI.
    const orphaned = !openCodeSessionId.test(sessionId);
    this.sessions.set(sessionId, { projectPath, instructions, opencodeId: orphaned ? undefined : sessionId, verified: false, orphaned });
  }

  async *runTurn(sessionId: string, prompt: string): AsyncGenerator<RuntimeEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Agent Session must be started or resumed first");
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    if (this.closed) throw new RuntimeFailure("pre_start", true);
    if (session.orphaned) throw new RuntimeFailure("session_missing");
    // A first Turn that never streamed a session ID left no OpenCode session to resume, so in this process the next
    // Turn starts a fresh one, matching the Claude adapter's in-process "new" state; after a restart it is orphaned.
    const active: ActiveTurn = {};
    this.active.set(sessionId, active);
    try {
      // `--session` with an unknown ID silently creates an empty session, so an unseen ID is checked first.
      if (session.opencodeId && !session.verified) {
        const check = await this.sessionExists(session, active);
        if (active.cancelRequested) throw new RuntimeFailure("cancelled");
        if (check === "missing") throw new RuntimeFailure("session_missing");
        if (check === "unknown") throw new RuntimeFailure("pre_start", true);
        session.verified = true;
        if (this.closed) throw new RuntimeFailure("pre_start", true);
      }
      const attempt = yield* this.attempt(session, prompt, active);
      // OpenCode already rejected these requests; reporting them never changes the Turn's own outcome. The streamed
      // OpenCode ID is passed when known because the yielded `session` event has already rebound SQLite to it.
      if (attempt.denials > 0) {
        try { this.onPermissionDenied?.(session.opencodeId ?? sessionId, attempt.denials); } catch { /* the notice is best-effort */ }
      }
      if (attempt.spawnFailed) throw new RuntimeFailure("pre_start", true);
      const answer = attempt.texts.join("\n\n");
      // An answer without an OpenCode session ID could not be resumed, so it would silently lose context next Turn.
      if (attempt.exitCode === 0 && !attempt.errored && !attempt.mismatched && !attempt.timedOut && session.opencodeId && answer.trim()) {
        // Only a Turn that succeeded proves the session; a failed first Turn's ID is checked before its first resume.
        session.verified = true;
        yield { type: "answer", text: answer };
        return;
      }
      if (attempt.timedOut) throw new RuntimeFailure("timed_out");
      if (attempt.authentication) throw new RuntimeFailure("authentication");
      if (attempt.usage) throw new RuntimeFailure("usage");
      if (active.cancelRequested) throw new RuntimeFailure("cancelled");
      // OpenCode records the user message before its first event, so a spawned run is never replay-safe.
      throw new RuntimeFailure("uncertain");
    } finally {
      await this.stop(active, "SIGINT");
      this.active.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.cancelRequested = true;
    await this.stop(active, "SIGINT");
  }

  // Read-only and creates nothing: exit 0 means the session exists; SessionNotFoundError means it is gone.
  private sessionExists(session: SessionState, active: ActiveTurn): Promise<"exists" | "missing" | "unknown"> {
    return new Promise((resolve) => {
      const child = spawn(this.executable, ["api", "--standalone", "GET", `/api/session/${session.opencodeId}`],
        { cwd: session.projectPath, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      active.child = child;
      active.exited = new Promise<void>((settle) => { child.once("error", () => settle()); child.once("close", () => settle()); });
      const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 10_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxCheckBytes) { failed = true; child.kill("SIGKILL"); return; }
        chunks.push(chunk);
      });
      child.once("error", () => { clearTimeout(timer); resolve("unknown"); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed) { resolve("unknown"); return; }
        if (code === 0) { resolve("exists"); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { resolve("unknown"); return; }
        const notFound = code === 1 && typeof parsed === "object" && parsed !== null && (parsed as { _tag?: unknown })._tag === "SessionNotFoundError";
        resolve(notFound ? "missing" : "unknown");
      });
    });
  }

  private async *attempt(session: SessionState, prompt: string, active: ActiveTurn): AsyncGenerator<RuntimeEvent, Attempt> {
    const outcome: Attempt = { spawnFailed: false, timedOut: false, authentication: false, usage: false, errored: false, mismatched: false, exitCode: null, texts: [], denials: 0 };
    const args = ["run", "--format", "json", "--standalone", ...(session.opencodeId ? ["--session", session.opencodeId] : [])];
    // No shell and the inherited environment; stderr is discarded because it echoes raw permission resources.
    const child = spawn(this.executable, args, { cwd: session.projectPath, stdio: ["pipe", "pipe", "ignore"] });
    const lines: string[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => { if (child.pid === undefined) outcome.spawnFailed = true; resolve(); });
      child.once("close", (code) => { outcome.exitCode = code; resolve(); });
    }).then(() => { ended = true; wake?.(); });
    active.child = child;
    active.exited = exited;
    const idleTimer = setTimeout(() => {
      outcome.timedOut = true;
      void this.stop(active, "SIGTERM");
    }, this.idleTimeoutMs);
    createInterface({ input: child.stdout! }).on("line", (line) => { idleTimer.refresh(); lines.push(line); wake?.(); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(personaPrompt(session.instructions, prompt));
    try {
      while (true) {
        if (lines.length === 0) {
          if (ended) break;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
          continue;
        }
        let event: StreamEvent;
        try { event = JSON.parse(lines.shift()!) as StreamEvent; } catch { continue; }
        if (typeof event !== "object" || event === null || outcome.mismatched) continue;
        if (typeof event.sessionID === "string") {
          if (!openCodeSessionId.test(event.sessionID)) {
            // A malformed ID is never bound, aliased, or passed on; the Turn fails closed like a mismatch.
            outcome.mismatched = true;
            void this.stop(active, "SIGINT");
            continue;
          }
          if (!session.opencodeId) {
            session.opencodeId = event.sessionID;
            this.sessions.set(event.sessionID, session);
            yield { type: "session", id: event.sessionID };
          } else if (event.sessionID !== session.opencodeId) {
            outcome.mismatched = true;
            void this.stop(active, "SIGINT");
            continue;
          }
        }
        // Only the final step is the answer; text from earlier tool-call steps is interim narration.
        if (event.type === "step_start") outcome.texts = [];
        else if (event.type === "text" && typeof event.part?.text === "string") outcome.texts.push(event.part.text);
        else if (event.type === "error") {
          outcome.errored = true;
          const kind = typeof event.error?.type === "string" ? event.error.type : "";
          if (authenticationErrors.has(kind)) outcome.authentication = true;
          if (usageErrors.has(kind)) outcome.usage = true;
        }
        // tool_use events carry raw tool input and output; only permission rejections are counted, nothing is kept.
        else if (event.type === "tool_use" && event.part?.state?.status === "error" && typeof event.part.state.error === "string"
          && event.part.state.error.startsWith(permissionRejection)) outcome.denials++;
      }
    } finally {
      clearTimeout(idleTimer);
    }
    return outcome;
  }

  private async stop(active: ActiveTurn, signal: NodeJS.Signals): Promise<void> {
    const { child, exited } = active;
    if (!child || !exited) return;
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited.finally(() => clearTimeout(forced));
    }
    await exited;
  }
}

// The persona travels with every Turn because OpenCode 2.0.22 ignores configured instruction files.
function personaPrompt(instructions: string, prompt: string): string {
  return `[inoai operating instructions (not a user message)]\n${instructions.trim()}\n[end of inoai operating instructions]\n\n${prompt}`;
}
