import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { CodexAppServer } from "./codex-app-server.js";

type ProbeNotice = { method: string; params: unknown; atMs: number };

// Turn starts can be announced before either shell command actually runs.
export function probeShowsConcurrentExecution(threads: string[], notices: ProbeNotice[]): boolean {
  const commands = new Map<string, { id: string; started: number; completed?: number }>();
  const turns = new Map<string, number>();
  for (const { method, params, atMs } of notices) {
    const notice = params as { threadId?: string; turn?: { status?: string }; item?: {
      id?: string; type?: string; command?: string; exitCode?: number;
    } } | null;
    const threadId = notice?.threadId;
    if (!threadId || !threads.includes(threadId)) continue;
    if (method === "turn/completed" && notice?.turn?.status === "completed") turns.set(threadId, atMs);
    if (notice?.item?.type !== "commandExecution") continue;
    if (method === "item/started") {
      if (commands.has(threadId) || !notice.item.id || notice.item.command?.trim() !== "sleep 8") return false;
      commands.set(threadId, { id: notice.item.id, started: atMs });
    } else if (method === "item/completed") {
      const command = commands.get(threadId);
      if (!command || command.completed !== undefined || notice.item.id !== command.id || notice.item.exitCode !== 0) return false;
      command.completed = atMs;
    }
  }
  if (threads.length !== 2 || new Set(threads).size !== 2 || turns.size !== 2 || commands.size !== 2) return false;
  const executions = threads.map((id) => commands.get(id)!);
  return executions.every((command, index) => command.completed !== undefined
    && command.completed - command.started >= 7_000 && turns.get(threads[index]!)! >= command.completed)
    && Math.max(...executions.map((command) => command.started)) < Math.min(...executions.map((command) => command.completed!))
    // Two sequential eight-second sleeps need at least sixteen seconds.
    && Math.max(...executions.map((command) => command.completed!)) - Math.min(...executions.map((command) => command.started)) < 14_000;
}

// A fresh app-server and disposable project keep the probe separate from live turns.
export async function probeCodexConcurrency(): Promise<boolean> {
  let project: string | undefined;
  let server: CodexAppServer | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    project = await mkdtemp(join(tmpdir(), "inoai-codex-concurrency-"));
    server = await CodexAppServer.connect({ timeoutMs: 15_000 });
    timeout = setTimeout(() => { void server?.close().catch(() => undefined); }, 60_000);
    const startThread = async (): Promise<string> => {
      const result = await server!.request("thread/start", {
        cwd: project, sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
        developerInstructions: "This is a read-only concurrency check. Do not write files or request permission changes.",
      }, 30_000) as { thread?: { id?: string } };
      if (!result?.thread?.id) throw new Error("Probe thread did not start");
      return result.thread.id;
    };
    const threads = await Promise.all([startThread(), startThread()]);
    if (threads[0] === threads[1]) return false;
    const notices: ProbeNotice[] = [];
    const completed = new Set<string>();
    let wake: (() => void) | undefined;
    const removeListener = server.addNotificationListener((method, params) => {
      const notice = params as { threadId?: string; turn?: { status?: string } } | null;
      const id = notice?.threadId;
      if (!id || !threads.includes(id)) return;
      notices.push({ method, params, atMs: performance.now() });
      if (method === "turn/completed") completed.add(id);
      wake?.();
    });
    try {
      const prompt = "Run the read-only shell command `sleep 8`, then answer with one word: ready. Do not edit files.";
      await Promise.all(threads.map((threadId) => server!.request("turn/start", {
        threadId, cwd: project, input: [{ type: "text", text: prompt }],
        sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never",
      }, 30_000)));
      const deadline = Date.now() + 45_000;
      while (completed.size < 2 && server.health().state === "ready" && Date.now() < deadline) {
        await Promise.race([
          new Promise<void>((resolve) => { wake = resolve; }),
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now()))),
        ]);
        wake = undefined;
      }
      return probeShowsConcurrentExecution(threads, notices);
    } finally {
      removeListener();
    }
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    await server?.close().catch(() => undefined);
    if (project) await rm(project, { recursive: true, force: true }).catch(() => undefined);
  }
}

// `probe` is the index of the CLI process (0 or 1) that printed `event`, timed when its line was read.
export type ClaudeProbeEvent = { probe: number; event: unknown; atMs: number };
type ClaudeStreamEvent = {
  type?: string; subtype?: string; session_id?: unknown; apiKeySource?: unknown; is_error?: unknown; parent_tool_use_id?: unknown;
  event?: { type?: string; delta?: { type?: string; text?: unknown } };
};

function isTextDelta(event: ClaudeStreamEvent): boolean {
  return event.type === "stream_event" && event.parent_tool_use_id == null && event.event?.type === "content_block_delta"
    && event.event.delta?.type === "text_delta" && typeof event.event.delta.text === "string";
}

// Both sessions must start under the subscription sign-in, stream text before either finishes, and both succeed.
export function probeShowsConcurrentStreaming(events: ClaudeProbeEvent[]): boolean {
  const runs = [0, 1].map(() => ({ session: undefined as string | undefined, firstDelta: undefined as number | undefined,
    resultAt: undefined as number | undefined, succeeded: false }));
  for (const { probe, event, atMs } of events) {
    const run = runs[probe];
    const stream = event as ClaudeStreamEvent | null;
    if (!run || typeof stream !== "object" || stream === null) return false;
    if (stream.type === "system" && stream.subtype === "init") {
      if (run.session !== undefined || stream.apiKeySource !== "none" || typeof stream.session_id !== "string" || !stream.session_id) return false;
      run.session = stream.session_id;
    } else if (isTextDelta(stream)) {
      if (run.session === undefined) return false;
      if (run.resultAt === undefined) run.firstDelta ??= atMs;
    } else if (stream.type === "result") {
      if (run.resultAt !== undefined) return false;
      run.resultAt = atMs;
      run.succeeded = stream.is_error === false && stream.subtype === "success";
    }
  }
  if (!runs.every((run) => run.session !== undefined && run.succeeded && run.firstDelta !== undefined && run.resultAt !== undefined)) return false;
  if (runs[0]!.session === runs[1]!.session) return false;
  return Math.max(...runs.map((run) => run.firstDelta!)) < Math.min(...runs.map((run) => run.resultAt!));
}

export type ClaudeProbeOptions = { executable?: string; homeDir?: string; timeoutMs?: number };

// Tools are disabled and nothing is persisted, so the probe needs no permission. `--tools ""` removes every
// built-in tool and `--strict-mcp-config` (with no --mcp-config) removes MCP tools; both only restrict.
// haiku keeps the two throwaway sessions cheap; overlap depends on the CLI and account, not the model.
export const claudeProbeArgs = [
  "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
  "--permission-prompts", "none", "--tools", "", "--strict-mcp-config", "--model=haiku",
];
const claudeProbePrompt = "Write the numbers 1 to 150 as a counted list, one number per line, with no other text. Do not use any tools.";
const claudeProbeExitGraceMs = 2_000;
export const claudeProbeLeftoverWarning = "Claude concurrency probe: the CLI project folder for the probe held unexpected files and was left in place";

// Two fresh `claude -p` processes in a disposable project keep the probe separate from live Turns. Never throws.
export async function probeClaudeConcurrency({ executable = "claude", homeDir = homedir(), timeoutMs = 90_000 }: ClaudeProbeOptions = {}): Promise<boolean> {
  let project: string | undefined;
  let encoded: string | undefined;
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  let timer: NodeJS.Timeout | undefined;
  let passed = false;
  try {
    project = await mkdtemp(join(tmpdir(), "inoai-claude-concurrency-"));
    // The CLI names its project folder after the resolved cwd with every non-alphanumeric replaced by "-".
    encoded = (await realpath(project)).replace(/[^A-Za-z0-9]/g, "-");
    const events: ClaudeProbeEvent[] = [];
    let failed = false;
    const killAll = () => { for (const child of children) killProbe(child); };
    timer = setTimeout(() => { failed = true; killAll(); }, timeoutMs);
    for (const probe of [0, 1]) {
      // No shell; stderr is discarded so raw CLI diagnostics never reach logs.
      const child = spawn(executable, claudeProbeArgs, { cwd: project, stdio: ["pipe", "pipe", "ignore"] });
      children.push(child);
      exits.push(new Promise<void>((resolve) => {
        let grace: NodeJS.Timeout | undefined;
        const done = () => { if (grace) clearTimeout(grace); resolve(); };
        child.once("error", () => { failed = true; killAll(); done(); });
        child.once("close", done);
        // A process left behind by the CLI can hold stdout open after the CLI exits, so `close` may never fire:
        // stop waiting shortly after exit so startup stays bounded by the timeout plus this grace period.
        child.once("exit", () => {
          grace = setTimeout(() => { child.stdout?.destroy(); child.stdin?.destroy(); done(); }, claudeProbeExitGraceMs);
        });
      }));
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let event: ClaudeStreamEvent;
        try { event = JSON.parse(line) as ClaudeStreamEvent; } catch { return; }
        if (typeof event !== "object" || event === null) return;
        const isInit = event.type === "system" && event.subtype === "init";
        // A non-subscription credential must not bill anything: stop both sessions at once.
        if (isInit && event.apiKeySource !== "none") { failed = true; killAll(); }
        // Only the events the pass rule reads are kept, and only their non-secret fields.
        if (isInit || isTextDelta(event) || event.type === "result") {
          events.push({ probe, atMs: performance.now(), event: {
            type: event.type, subtype: event.subtype, session_id: event.session_id, apiKeySource: event.apiKeySource,
            is_error: event.is_error, parent_tool_use_id: event.parent_tool_use_id, event: event.event,
          } });
        }
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(claudeProbePrompt);
    }
    await Promise.all(exits);
    passed = !failed && probeShowsConcurrentStreaming(events);
  } catch {
    passed = false;
  } finally {
    if (timer) clearTimeout(timer);
    for (const child of children) killProbe(child);
    // The CLI may still be writing its project folder until it exits.
    await Promise.all(exits).catch(() => undefined);
    if (project) await rm(project, { recursive: true, force: true }).catch(() => undefined);
    if (encoded) await removeProbeProjectFolder(join(homeDir, ".claude", "projects", encoded)).catch(() => console.warn(claudeProbeLeftoverWarning));
  }
  return passed;
}

// A child that never spawned has no pid; signalling it can reach this process's own group, so it is skipped.
// Exported for a non-destructive unit test of that guard.
export function killProbe(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

// Deletes the folder only when it holds nothing but an empty `memory/` directory (no session .jsonl or anything else).
// A missing folder is fine. Also used by Claude Memory Reviews, which run in the same kind of disposable cwd.
export async function removeProbeProjectFolder(folder: string): Promise<void> {
  let stats;
  try { stats = await lstat(folder); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const memory = join(folder, "memory");
  if (!stats.isDirectory()) throw new Error("unexpected");
  const entries = await readdir(folder);
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== "memory")) throw new Error("unexpected");
  if (entries.length === 1) {
    if (!(await lstat(memory)).isDirectory() || (await readdir(memory)).length > 0) throw new Error("unexpected");
    // rmdir (never recursive) fails if anything appeared in the meantime.
    await rmdir(memory);
  }
  await rmdir(folder);
}
