import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
