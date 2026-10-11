import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

// The adapter consumes this transport; no Discord or SQLite state belongs here.
export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly serverRequests = new Set<number | string>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly requestListeners = new Set<(method: string, params: unknown, id: number | string) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly exited: Promise<void>;
  private exitDone!: () => void;
  private nextId = 0;
  private state: "connecting" | "ready" | "stopped" | "error" = "connecting";
  onRequest?: (method: string, params: unknown, id: number | string) => void;
  onNotification?: (method: string, params: unknown) => void;

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process;
    this.exited = new Promise((resolve) => { this.exitDone = resolve; });
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => {
      try { this.receive(JSON.parse(line) as Message); }
      catch { this.fail("Codex app-server sent an invalid response"); process.kill(); }
    });
    // Codex stderr can contain tool output or credentials; never relay it.
    process.stderr.resume();
    process.stdin.on("error", () => this.fail("Codex app-server connection failed"));
    process.on("error", () => this.fail("Codex app-server could not start"));
    process.on("exit", () => { this.fail("Codex app-server exited"); this.exitDone(); });
  }

  static async connect(options: { spawnProcess?: () => ChildProcessWithoutNullStreams; timeoutMs?: number } = {}): Promise<CodexAppServer> {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const child = options.spawnProcess?.() ?? spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env });
    const client = new CodexAppServer(child);
    try {
      await client.request("initialize", { clientInfo: { name: "inoai", title: "inoai", version: "0.1.0" } }, options.timeoutMs);
      client.send({ method: "initialized", params: {} });
      let account: { account?: { type?: string } };
      try {
        account = await client.request("account/read", { refreshToken: true }, options.timeoutMs) as typeof account;
      } catch {
        throw new Error("Codex ChatGPT sign-in could not be verified; run codex login locally");
      }
      if (account?.account?.type !== "chatgpt") throw new Error("Codex ChatGPT sign-in is required; run codex login locally");
      client.state = "ready";
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  health(): { state: "ready" | "stopped" | "error" } {
    return { state: this.state === "connecting" ? "stopped" : this.state };
  }

  addNotificationListener(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  addRequestListener(listener: (method: string, params: unknown, id: number | string) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  hasRequest(id: number | string): boolean { return this.serverRequests.has(id); }

  addFailureListener(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.state === "stopped" || this.state === "error") return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Codex app-server connection failed")); }
    });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.serverRequests.has(id)) throw new Error("Codex approval request is no longer live");
    this.send({ id, result });
    this.serverRequests.delete(id);
  }

  async close(): Promise<void> {
    if (this.state === "stopped") return;
    this.fail("Codex app-server closed", "stopped");
    this.state = "stopped";
    this.process.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
    if (timer) clearTimeout(timer);
    if (this.process.exitCode === null) this.process.kill("SIGKILL");
  }

  private send(message: Message): void {
    if (this.state === "stopped" || this.state === "error") throw new Error("Codex app-server is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: Message): void {
    if (!message || typeof message !== "object" || this.state === "stopped" || this.state === "error") return;
    if (message.id !== undefined && typeof message.method === "string") {
      this.serverRequests.add(message.id);
      this.onRequest?.(message.method, message.params, message.id);
      for (const listener of this.requestListeners) listener(message.method, message.params, message.id);
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error("Codex request failed"));
      else pending.resolve(message.result);
    } else if (typeof message.method === "string") {
      if (message.method === "serverRequest/resolved" && message.params && typeof message.params === "object" && "requestId" in message.params) {
        this.serverRequests.delete(message.params.requestId as number | string);
      }
      this.onNotification?.(message.method, message.params);
      for (const listener of this.notificationListeners) listener(message.method, message.params);
    }
  }

  private fail(reason: string, state: "stopped" | "error" = "error"): void {
    if (this.state === "stopped" || this.state === "error") return;
    this.state = state;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.serverRequests.clear();
    for (const listener of this.failureListeners) listener(new Error(reason));
  }
}
