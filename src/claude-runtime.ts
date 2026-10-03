import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { RuntimeFailure, reviewInstructions } from "./agent-runtime.js";
import type { AgentRuntime, ReviewOptions, RuntimeEvent } from "./agent-runtime.js";
import { killProbe, removeProbeProjectFolder } from "./concurrency-probe.js";

// "new": created here and never seen to start, so the next Turn uses --session-id.
// "persisted": the CLI reported init for this ID, or it was resumed from SQLite after a restart.
type SessionState = { projectPath: string; instructions: string; state: "new" | "persisted" };
type ActiveTurn = { child?: ChildProcess; exited?: Promise<void>; cancelRequested?: boolean };
type StreamEvent = {
  type?: string; subtype?: string; session_id?: string; apiKeySource?: unknown; error?: unknown; parent_tool_use_id?: unknown;
  event?: { type?: string; delta?: { type?: string; text?: unknown } };
  rate_limit_info?: { status?: string };
  is_error?: boolean; result?: unknown; terminal_reason?: string; errors?: unknown; permission_denials?: unknown;
};
type Attempt = { started: boolean; result?: StreamEvent; credentialRefused: boolean; authentication: boolean; usage: boolean; spawnFailed: boolean; timedOut: boolean; mismatched: boolean; deniedEvents: number };

// Called at most once per Turn with only the Agent Session ID and a denial count; it never sees tool input.
export type PermissionDenialListener = (sessionId: string, count: number) => void;
// homeDir locates `~/.claude/projects` for review cleanup only; reviewTimeoutMs bounds one whole review.
export type ClaudeRuntimeOptions = { executable?: string; model?: string; idleTimeoutMs?: number; reviewTimeoutMs?: number; homeDir?: string; onPermissionDenied?: PermissionDenialListener };
type ReviewEvent = {
  type?: string; subtype?: string; apiKeySource?: unknown; tools?: unknown; mcp_servers?: unknown; memory_paths?: unknown; error?: unknown;
  message?: { content?: unknown }; rate_limit_info?: { status?: string };
  is_error?: boolean; result?: unknown; permission_denials?: unknown;
};
type ReviewAttempt = { initSeen: boolean; credentialRefused: boolean; unsafe: boolean; authentication: boolean; usage: boolean; spawnFailed: boolean; timedOut: boolean; cancelled: boolean; result?: ReviewEvent };

export const claudeReviewLeftoverWarning = "Claude Memory Review: the CLI project folder for the review held unexpected files and was left in place";
const reviewExitGraceMs = 2_000;

const authenticationErrors = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"]);
const usageErrors = new Set(["rate_limit", "billing_error"]);

export class ClaudeRuntime implements AgentRuntime {
  readonly displayName = "Claude";
  readonly loginHint = "claude /login";
  private readonly sessions = new Map<string, SessionState>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly executable: string;
  private readonly model?: string;
  private readonly idleTimeoutMs: number;
  private readonly reviewTimeoutMs: number;
  private readonly homeDir: string;
  private readonly onPermissionDenied?: PermissionDenialListener;
  private closed = false;

  constructor({ executable = "claude", model, idleTimeoutMs = 300_000, reviewTimeoutMs = 600_000, homeDir = homedir(), onPermissionDenied }: ClaudeRuntimeOptions = {}) {
    this.executable = executable;
    this.model = model;
    this.idleTimeoutMs = idleTimeoutMs;
    this.reviewTimeoutMs = reviewTimeoutMs;
    this.homeDir = homeDir;
    this.onPermissionDenied = onPermissionDenied;
  }

  // Confirms the installed CLI can be spawned and will use the owner's subscription /login before Discord starts.
  // It asks the CLI (never reads credential files or settings) and never changes the environment.
  static async connect(options: ClaudeRuntimeOptions = {}): Promise<ClaudeRuntime> {
    const executable = options.executable ?? "claude";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Claude CLI is unavailable")); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Claude CLI is unavailable")); });
    });
    // Presence only: the value is never read, printed, or stripped.
    if ("CLAUDE_CODE_OAUTH_TOKEN" in process.env) throw refusal("CLAUDE_CODE_OAUTH_TOKEN in the environment");
    const status = await readAuthStatus(executable);
    if (typeof status.authMethod !== "string" || typeof status.apiProvider !== "string") throw new Error(unverified);
    const override = credentialOverride(status);
    if (override) throw refusal(override);
    if (status.loggedIn !== true || status.authMethod === "none") throw new Error("Claude subscription sign-in is required; run claude /login locally");
    if (!status.exitedCleanly) throw new Error(unverified);
    return new ClaudeRuntime(options);
  }

  health(): { state: "ready" | "stopped" | "error" } { return { state: this.closed ? "stopped" : "ready" }; }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.values()].map((active) => this.stop(active, "SIGINT")));
  }

  async createSession(projectPath: string, instructions: string): Promise<string> {
    const id = randomUUID();
    this.sessions.set(id, { projectPath, instructions, state: "new" });
    return id;
  }

  async resumeSession(sessionId: string, projectPath: string, instructions: string): Promise<void> {
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    const known = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { projectPath, instructions, state: known?.state ?? "persisted" });
  }

  async *runTurn(sessionId: string, prompt: string): AsyncGenerator<RuntimeEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Agent Session must be started or resumed first");
    if (this.active.has(sessionId)) throw new Error("Agent Session has an active turn");
    if (this.closed) throw new RuntimeFailure("pre_start", true);
    const active: ActiveTurn = {};
    this.active.set(sessionId, active);
    try {
      const attempt = yield* this.attempt(sessionId, session, prompt, active);
      const { result } = attempt;
      // The CLI already denied these prompts; reporting them never changes the Turn's own outcome.
      const denials = Math.max(attempt.deniedEvents, Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0);
      if (denials > 0) {
        try { this.onPermissionDenied?.(sessionId, denials); } catch { /* the notice is best-effort */ }
      }
      if (attempt.spawnFailed) throw new RuntimeFailure("pre_start", true);
      // Not replay-safe: the CLI had already initialized, and a replay would meet the same credential.
      if (attempt.credentialRefused) throw new RuntimeFailure("authentication");
      if (attempt.mismatched) throw new RuntimeFailure("uncertain");
      // Classify from the final result event, not the exit code: SIGINT exits 0 and a login error can report "success".
      if (result?.is_error === false && result.subtype === "success" && typeof result.result === "string") {
        yield { type: "answer", text: result.result };
        return;
      }
      if (attempt.timedOut) throw new RuntimeFailure("timed_out");
      if (attempt.authentication) throw new RuntimeFailure("authentication");
      if (attempt.usage) throw new RuntimeFailure("usage");
      // A missing conversation is never recreated under the thread's ID and never replayed: only /inoai reset recovers.
      if (notFound(result)) throw new RuntimeFailure("session_missing");
      if (active.cancelRequested && (!attempt.started || !result || result.terminal_reason === "aborted_streaming")) throw new RuntimeFailure("cancelled");
      if (!attempt.started) throw new RuntimeFailure("pre_start", true);
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

  // One Memory Review in a fresh disposable cwd with no session, tools, MCP servers, owner context, or persistence
  // (ADR 0010). The cwd is never the project: a project cwd would add its CLAUDE.md and folder context to a text-only
  // summary for no benefit. Prompt and answer are never logged or stored here. Every failure is replay-safe.
  async review(prompt: string, { signal }: ReviewOptions = {}): Promise<string> {
    if (this.closed) throw new RuntimeFailure("pre_start", true);
    if (signal?.aborted) throw new RuntimeFailure("cancelled", true);
    let cwd: string | undefined;
    let encoded: string;
    try {
      cwd = await mkdtemp(join(tmpdir(), "inoai-claude-review-"));
      // The CLI names its project folder after the resolved cwd with every non-alphanumeric replaced by "-".
      encoded = (await realpath(cwd)).replace(/[^A-Za-z0-9]/g, "-");
    } catch {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      throw new RuntimeFailure("pre_start", true);
    }
    // An abort or close while the cwd was being created must not reach spawn: no listener was attached yet.
    if (signal?.aborted || this.closed) {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      throw new RuntimeFailure(signal?.aborted ? "cancelled" : "pre_start", true);
    }
    const key = `review:${randomUUID()}`;
    const active: ActiveTurn = {};
    this.active.set(key, active);
    try {
      const attempt = await this.reviewAttempt(cwd, prompt, active, signal);
      const { result } = attempt;
      if (attempt.spawnFailed) throw new RuntimeFailure("pre_start", true);
      if (attempt.credentialRefused) throw new RuntimeFailure("authentication", true);
      if (attempt.unsafe) throw new RuntimeFailure("uncertain", true);
      if (attempt.cancelled) throw new RuntimeFailure("cancelled", true);
      if (attempt.initSeen && result?.is_error === false && result.subtype === "success" && typeof result.result === "string") return result.result;
      if (attempt.timedOut) throw new RuntimeFailure("timed_out", true);
      if (attempt.authentication) throw new RuntimeFailure("authentication", true);
      if (attempt.usage) throw new RuntimeFailure("usage", true);
      if (!attempt.initSeen && !result) throw new RuntimeFailure("pre_start", true);
      throw new RuntimeFailure("uncertain", true);
    } finally {
      await this.stopReview(active, "SIGINT");
      this.active.delete(key);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      await removeProbeProjectFolder(join(this.homeDir, ".claude", "projects", encoded)).catch(() => console.warn(claudeReviewLeftoverWarning));
    }
  }

  private reviewArgs(): string[] {
    return [
      "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--permission-prompts", "none", "--tools", "", "--strict-mcp-config", "--safe-mode",
      "--system-prompt", reviewInstructions,
      ...(this.model ? [`--model=${this.model}`] : []),
    ];
  }

  private async reviewAttempt(cwd: string, prompt: string, active: ActiveTurn, signal?: AbortSignal): Promise<ReviewAttempt> {
    const outcome: ReviewAttempt = { initSeen: false, credentialRefused: false, unsafe: false, authentication: false, usage: false, spawnFailed: false, timedOut: false, cancelled: false };
    // No shell; stderr is discarded so raw CLI diagnostics never reach logs.
    const child = spawn(this.executable, this.reviewArgs(), { cwd, stdio: ["pipe", "pipe", "ignore"] });
    active.child = child;
    active.exited = new Promise<void>((resolve) => {
      let grace: NodeJS.Timeout | undefined;
      const done = () => { if (grace) clearTimeout(grace); resolve(); };
      child.once("error", () => { outcome.spawnFailed = !outcome.initSeen; done(); });
      child.once("close", done);
      // A process left behind by the CLI can hold stdout open after exit; stop waiting shortly after the CLI exits.
      child.once("exit", () => { grace = setTimeout(() => { child.stdout?.destroy(); done(); }, reviewExitGraceMs); });
    });
    // Fail closed: stop at once without using anything else the stream carries.
    const refuse = (field: "credentialRefused" | "unsafe") => {
      if (outcome.credentialRefused || outcome.unsafe) return;
      outcome[field] = true;
      void this.stopReview(active, "SIGKILL");
    };
    const timer = setTimeout(() => { outcome.timedOut = true; void this.stopReview(active, "SIGTERM"); }, this.reviewTimeoutMs);
    const onAbort = () => { outcome.cancelled = true; void this.stopReview(active, "SIGINT"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A listener never fires for a signal that was already aborted.
    if (signal?.aborted) onAbort();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (outcome.credentialRefused || outcome.unsafe) return;
      let event: ReviewEvent;
      try { event = JSON.parse(line) as ReviewEvent; } catch { return; }
      if (typeof event !== "object" || event === null) return;
      if (event.type === "system" && event.subtype === "init") {
        outcome.initSeen = true;
        if (event.apiKeySource !== "none") refuse("credentialRefused");
        else if (!isEmptyList(event.tools) || !isEmptyList(event.mcp_servers) || reportsMemoryPaths(event.memory_paths)) refuse("unsafe");
      } else if (event.type === "system" && event.subtype === "permission_denied") {
        refuse("unsafe");
      } else if ((event.type === "assistant" || event.type === "user") && hasToolUse(event.message?.content)) {
        refuse("unsafe");
      } else if (event.type === "assistant" && typeof event.error === "string") {
        if (authenticationErrors.has(event.error)) outcome.authentication = true;
        if (usageErrors.has(event.error)) outcome.usage = true;
      } else if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
        outcome.usage = true;
      } else if (event.type === "result") {
        if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) refuse("unsafe");
        else outcome.result = event;
      }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
    try {
      await active.exited;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    return outcome;
  }

  // Like stop(), but a child that never spawned (no pid) is never signalled.
  private async stopReview(active: ActiveTurn, signal: NodeJS.Signals): Promise<void> {
    const { child, exited } = active;
    if (!child || !exited) return;
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const forced = setTimeout(() => killProbe(child), 10_000);
      await exited.finally(() => clearTimeout(forced));
    }
    await exited;
  }

  private args(sessionId: string, session: SessionState): string[] {
    return [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      session.state === "new" ? "--session-id" : "--resume", sessionId,
      `--append-system-prompt=${session.instructions}`, "--system-prompt-snapshot", "off",
      "--permission-prompts", "none",
      ...(this.model ? [`--model=${this.model}`] : []),
    ];
  }

  private async *attempt(sessionId: string, session: SessionState, prompt: string, active: ActiveTurn): AsyncGenerator<RuntimeEvent, Attempt> {
    const outcome: Attempt = { started: false, credentialRefused: false, authentication: false, usage: false, spawnFailed: false, timedOut: false, mismatched: false, deniedEvents: 0 };
    // No shell; stderr is discarded so raw CLI diagnostics never reach logs.
    const child = spawn(this.executable, this.args(sessionId, session), { cwd: session.projectPath, stdio: ["pipe", "pipe", "ignore"] });
    const lines: string[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => { outcome.spawnFailed = !outcome.started; resolve(); });
      child.once("close", () => resolve());
    }).then(() => { ended = true; wake?.(); });
    active.child = child;
    active.exited = exited;
    const idleTimer = setTimeout(() => {
      outcome.timedOut = true;
      void this.stop(active, "SIGTERM");
    }, this.idleTimeoutMs);
    createInterface({ input: child.stdout! }).on("line", (line) => { idleTimer.refresh(); lines.push(line); wake?.(); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
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
        // After a credential refusal, drain the stream without using any of it.
        if (outcome.credentialRefused) continue;
        if (event.type === "system" && event.subtype === "init") {
          outcome.started = true;
          // A credential change after startup must never silently bill an API account: kill before the Turn does work.
          if (event.apiKeySource !== "none") {
            outcome.credentialRefused = true;
            void this.stop(active, "SIGKILL");
            // The CLI may already have recorded the session, so a later Turn resumes rather than reuses the ID.
            if (event.session_id === sessionId) session.state = "persisted";
          } else if (event.session_id !== sessionId) {
            outcome.mismatched = true;
            void this.stop(active, "SIGINT");
          } else session.state = "persisted";
        } else if (event.type === "stream_event" && event.parent_tool_use_id == null
          && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta" && typeof event.event.delta.text === "string") {
          yield { type: "progress", text: event.event.delta.text };
        } else if (event.type === "assistant" && typeof event.error === "string") {
          if (authenticationErrors.has(event.error)) outcome.authentication = true;
          if (usageErrors.has(event.error)) outcome.usage = true;
        } else if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
          outcome.usage = true;
        } else if (event.type === "system" && event.subtype === "permission_denied") {
          outcome.deniedEvents++;
        } else if (event.type === "result") {
          outcome.result = event;
        }
        // Tool use, tool results, and permission denials carry raw input; only denials are counted, nothing is stored.
      }
    } finally {
      clearTimeout(idleTimer);
    }
    return outcome;
  }

  private async stop(active: ActiveTurn, signal: NodeJS.Signals): Promise<void> {
    const { child, exited } = active;
    if (!child || !exited) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited.finally(() => clearTimeout(forced));
    }
    await exited;
  }
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

// Absent, null, or an empty list/object reports no memory paths; anything else does.
function reportsMemoryPaths(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => typeof block === "object" && block !== null
    && typeof (block as { type?: unknown }).type === "string" && (block as { type: string }).type.endsWith("tool_use"));
}

function notFound(result: StreamEvent | undefined): boolean {
  return Array.isArray(result?.errors) && result.errors.some((error) => typeof error === "string" && error.startsWith("No conversation found with session ID"));
}

const unverified = "Claude subscription sign-in could not be verified; run claude /login locally";
const maxStatusBytes = 65_536;

function refusal(source: string): Error {
  return new Error(`Claude credential refused: ${source} would override the subscription sign-in. inoai accepts only the interactive Claude subscription login (claude /login); remove that source locally and restart.`);
}

type AuthStatus = { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown; apiKeySource?: unknown; hasApiKeySource: boolean; exitedCleanly: boolean };

// Runs `claude auth status --json` without a shell. Only the four credential fields are kept; email, org,
// and every other field are dropped at parse time, and the raw output is never logged or persisted.
function readAuthStatus(executable: string): Promise<AuthStatus> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error(unverified)); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(); }, 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxStatusBytes) { child.kill("SIGKILL"); fail(); return; }
      chunks.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); fail(); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      let parsed: unknown;
      // A JSON.parse error message quotes the input, so it is replaced with a fixed message.
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(); return; }
      chunks.length = 0;
      if (typeof parsed !== "object" || parsed === null) { fail(); return; }
      const { loggedIn, authMethod, apiProvider, apiKeySource } = parsed as Record<string, unknown>;
      settled = true;
      resolve({ loggedIn, authMethod, apiProvider, apiKeySource, hasApiKeySource: Object.hasOwn(parsed, "apiKeySource"), exitedCleanly: code === 0 });
    });
  });
}

// Names the category of a non-subscription credential source, never its value. Labels are fixed strings.
function credentialOverride(status: AuthStatus): string | undefined {
  if (status.hasApiKeySource) {
    switch (status.apiKeySource) {
      case "ANTHROPIC_API_KEY": return "an API key (ANTHROPIC_API_KEY)";
      case "apiKeyHelper": return "an apiKeyHelper";
      case "/login managed key": return "a Console API key (/login managed key)";
      default: return "an API key";
    }
  }
  if (status.apiProvider !== "firstParty") return status.apiProvider === "gateway" ? "a cloud gateway" : "a cloud provider";
  switch (status.authMethod) {
    case "claude.ai": case "none": return undefined;
    case "oauth_token": return "an auth token or Anthropic profile (such as ANTHROPIC_AUTH_TOKEN or a token in Claude settings)";
    case "api_key_helper": return "an apiKeyHelper";
    case "api_key": return "an API key";
    case "third_party": return "a cloud provider";
    default: return "an unsupported credential source";
  }
}
